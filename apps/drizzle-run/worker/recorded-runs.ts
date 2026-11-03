import {
  MAX_RECORDED_RUN_BYTES,
  safeParseRecordedRun,
  type RecordedRun,
  type SafeParseRecordedRunResult,
} from "@drizzle-run/core/contracts";
import * as z from "zod/mini";

import { checkRateLimit, createApiError, isNotModified } from "./http";
import { logWorkerFailure } from "./logger";
import type { WorkerEnvironment } from "./platform";
import {
  authorizeLinkOwner,
  measureStoredBytes,
  requireSignedInUser,
  reservePublishBytes,
  type ReservedPublishBytes,
} from "./playgrounds";
import { createD1RecordedRunRepository, type RecordedRunRepository } from "./recorded-run-repository";
import type { ReadCurrentUser, SessionUser } from "./session";
import { createD1SnapshotRepository, type SnapshotRepository } from "./snapshot-repository";
import type { InputRefusal } from "./validation";

/** What the recorded run routes depend on: parsing, the clock, the session and the repositories. */
export interface RecordedRunServices {
  parseRecording(input: unknown): SafeParseRecordedRunResult;
  now(): string;
  recordings(database: WorkerEnvironment["PLAYGROUNDS"]): RecordedRunRepository;
  snapshots(database: WorkerEnvironment["PLAYGROUNDS"]): SnapshotRepository;
  /** The signed-in user, or null. */
  currentUser(request: Request, environment: WorkerEnvironment): Promise<SessionUser | null>;
}

/** The recorded run services the Worker runs with: the recording parser, the clock, the session and D1. */
export function createD1RecordedRunServices({ currentUser }: { currentUser: ReadCurrentUser }): RecordedRunServices {
  return {
    parseRecording: safeParseRecordedRun,
    now: () => new Date().toISOString(),
    recordings: createD1RecordedRunRepository,
    snapshots: createD1SnapshotRepository,
    currentUser,
  };
}

/** The largest recording body, in bytes: a little whitespace may surround the recording itself. */
export const maxRecordingBodyBytes = MAX_RECORDED_RUN_BYTES + 1024;

export const recordingTooLargeMessage = `A recorded run must be at most ${MAX_RECORDED_RUN_BYTES / 1024} KiB.`;

export const recordingNotFound = {
  status: 404,
  code: "recording_not_found",
  message: "This shared playground has no recorded run.",
} satisfies InputRefusal;

/** The refusal of a recording body that is not a recorded run. */
export const invalidRecording = {
  status: 422,
  code: "invalid_recording",
  message: "The recorded run is invalid.",
} satisfies InputRefusal;

/** A recording's body: any JSON, which `services.parseRecording` checks with its own issues. */
export const RecordingBodySchema = z.unknown();

/** What a recording sends, as its route reads it; `services.parseRecording` checks the body. */
export interface RecordingInput {
  id: string;
  body: unknown;
}

/**
 * Answers `PUT /api/playgrounds/:id/recording`
 *
 * Stores the author's run of the link's current snapshot, for its signed-in owner. The run must be of exactly that
 * snapshot. The link keeps its first recording until a push replaces the code: sending the same one
 * again succeeds, a different one is refused.
 */
export async function recordRun(
  request: Request,
  environment: WorkerEnvironment,
  { id, body }: RecordingInput,
  services: RecordedRunServices,
): Promise<Response> {
  const user = await requireSignedInUser({
    request,
    environment,
    sessions: services,
    signInMessage: "Sign in with the GitHub account that shared this link to add your run.",
  });

  if (user instanceof Response) {
    return user;
  }

  try {
    const snapshots = services.snapshots(environment.PLAYGROUNDS);
    const link = await authorizeLinkOwner({ id, user, links: snapshots });

    if (link instanceof Response) {
      return link;
    }

    const rateLimitResponse = await checkRateLimit(request, environment, "record", { userId: user.id });

    if (rateLimitResponse !== undefined) {
      return rateLimitResponse;
    }

    // Check the recording
    const parsed = services.parseRecording(body);

    if (!parsed.success) {
      return toRecordingValidationError(parsed.issues);
    }

    // Match it to the code the link shows
    if (parsed.data.snapshotDigest !== link.contentDigest) {
      return createApiError(
        409,
        "recording_digest_mismatch",
        "This run is of different code than the link shows. Run the pushed code and record again.",
      );
    }

    // Store it once; only a first recording counts its bytes
    const recordings = services.recordings(environment.PLAYGROUNDS);
    const payloadJson = JSON.stringify(parsed.data);

    let reserved: ReservedPublishBytes | undefined;

    if ((await recordings.find(id)) === null) {
      const reservation = await reservePublishBytes({
        repository: snapshots,
        environment,
        request,
        bytes: measureStoredBytes({ texts: [payloadJson, parsed.data.snapshotDigest], rows: 1 }),
      });

      if (reservation instanceof Response) {
        return reservation;
      }

      reserved = reservation;
    }

    // An insert that throws may still have landed, so its bytes stay counted: a total a little high only pauses
    // publishing sooner, where one too low could fill D1.
    const inserted = await recordings.insertIfNew({
      linkId: id,
      snapshotDigest: parsed.data.snapshotDigest,
      payloadJson,
      recordedAt: parsed.data.recordedAt,
      createdAt: services.now(),
    });

    // A concurrent recording was stored instead, even an identical one, or a push replaced the code: this one added
    // nothing.
    if (!inserted) {
      await reserved?.release();
    }

    const saved = await recordings.find(id);

    if (saved === null || saved.snapshotDigest !== parsed.data.snapshotDigest) {
      return createApiError(
        409,
        "recording_digest_mismatch",
        "The link's code changed while recording. Run the pushed code and record again.",
      );
    }

    if (saved.payloadJson !== payloadJson) {
      return createApiError(409, "recording_exists", "This shared playground already has a recorded run.");
    }

    return Response.json({ recordedAt: saved.recordedAt }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    logWorkerFailure({
      event: "recording_save_failed",
      cause,
      message: "Recording a run failed",
      request,
    });
    return createApiError(503, "recording_storage_unavailable", "The run could not be recorded right now. Try again.");
  }
}

/**
 * Answers `GET /api/playgrounds/:id/recording`
 *
 * The recorded run of the link's current snapshot, checked against its digest. A push can replace it, so every read
 * revalidates; a link without one answers 404.
 */
export async function readRecordedRun(
  request: Request,
  environment: WorkerEnvironment,
  { id }: { id: string },
  services: RecordedRunServices,
): Promise<Response> {
  let recording: Awaited<ReturnType<RecordedRunRepository["find"]>>;
  let link: Awaited<ReturnType<SnapshotRepository["findLink"]>>;

  try {
    [recording, link] = await Promise.all([
      services.recordings(environment.PLAYGROUNDS).find(id),
      services.snapshots(environment.PLAYGROUNDS).findLink(id),
    ]);
  } catch (cause) {
    logWorkerFailure({
      event: "recording_read_failed",
      cause,
      message: "Loading a recorded run failed",
      request,
    });
    return createApiError(503, "recording_storage_unavailable", "The recorded run could not be loaded right now.");
  }

  if (recording === null || link === null || recording.snapshotDigest !== link.contentDigest) {
    return createApiError(404, "recording_not_found", "This shared playground has no recorded run.");
  }

  const verified = verifyStoredRecording(recording.payloadJson, services);

  if (verified === null || verified.snapshotDigest !== recording.snapshotDigest) {
    return createApiError(500, "recording_integrity_error", "The stored recorded run failed its integrity check.");
  }

  const etag = `"sha256-${recording.snapshotDigest}-r${Date.parse(recording.createdAt)}"`;
  const headers = new Headers({
    "Cache-Control": "no-cache",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  });

  if (isNotModified(request, etag)) {
    return new Response(null, { status: 304, headers });
  }

  headers.set("Content-Type", "application/json; charset=utf-8");

  return new Response(JSON.stringify({ recording: verified }), { headers });
}

function verifyStoredRecording(payloadJson: string, services: RecordedRunServices): RecordedRun | null {
  try {
    const parsed = services.parseRecording(JSON.parse(payloadJson));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function toRecordingValidationError(issues: Extract<SafeParseRecordedRunResult, { success: false }>["issues"]) {
  if (issues.some((issue) => issue.code === "UNSUPPORTED_VERSION")) {
    return createApiError(422, "unsupported_version", "This recorded run format is not supported.");
  }

  if (issues.some((issue) => issue.code === "RECORDING_TOO_LARGE")) {
    return createApiError(413, "recording_too_large", recordingTooLargeMessage);
  }

  return Response.json(
    {
      error: {
        code: invalidRecording.code,
        message: invalidRecording.message,
        issues,
      },
    },
    { status: invalidRecording.status, headers: { "Cache-Control": "no-store" } },
  );
}
