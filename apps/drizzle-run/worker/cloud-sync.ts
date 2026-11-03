import { digestCloudProject, ProjectSourceSchema } from "@drizzle-run/core/contracts";
import * as z from "zod/mini";

import {
  createD1CloudRepository,
  type CloudProjectEntry,
  type CloudRepository,
  type CloudTotals,
} from "./cloud-repository";
import { createApiError, FieldsSchema, IntegerSchema, UuidV4Schema } from "./http";
import { logWorkerFailure } from "./logger";
import { hasControlCharacter } from "./plain-text";
import type { CloudProjectBucket, WorkerEnvironment } from "./platform";
import type { ReadCurrentUser, SessionUser } from "./session";
import type { InputRefusal } from "./validation";

/** What one account may sync. */
export const cloudSyncLimits = {
  maxProjects: 100,
  maxProjectBytes: 1024 * 1024, // 1 MiB, the snapshot cap
  maxTotalBytes: 25 * 1024 * 1024, // 25 MiB
} as const;

/** A synced project as the page sees it. */
export interface CloudProjectSummary {
  id: string;
  name: string;
  revision: number;
  digest: string;
  byteSize: number;
  updatedAt: string;
}

/** What the cloud sync routes depend on: the clock, the session and the index repository. */
export interface CloudSyncServices {
  now(): Date;
  /** The signed-in user, or null. */
  currentUser(request: Request, environment: WorkerEnvironment): Promise<SessionUser | null>;
  repository(database: WorkerEnvironment["PLAYGROUNDS"]): CloudRepository;
}

/** The cloud sync services the Worker runs with: the clock, the session and D1. */
export function createD1CloudSyncServices({ currentUser }: { currentUser: ReadCurrentUser }): CloudSyncServices {
  return {
    now: () => new Date(),
    currentUser,
    repository: createD1CloudRepository,
  };
}

const textEncoder = new TextEncoder();

/** The largest save body, in bytes: the record plus a base revision. */
export const maxSaveBodyBytes = cloudSyncLimits.maxProjectBytes + 1024;

/** Why a save is refused when its body or its record is larger than one project may be. */
export const cloudProjectTooLargeMessage = "This project is larger than 1 MB, so it stays local.";

/** How long a save refused by `CLOUD_SYNC_RATE_LIMIT` waits: the limiter's period in wrangler.jsonc. */
export const saveRateLimitRetryAfterMs = 60_000;

function toSummary(entry: CloudProjectEntry): CloudProjectSummary {
  return {
    id: entry.projectId,
    name: entry.name,
    revision: entry.revision,
    digest: entry.contentDigest,
    byteSize: entry.byteSize,
    updatedAt: entry.updatedAt,
  };
}

/**
 * Create the object key for one save
 *
 * Two saves based on the same revision may both write before one of them wins the index, so the revision alone would
 * let the loser overwrite the winner's object. A random suffix gives every save a key of its own; the index row
 * stores it, and reads follow the row.
 */
function createObjectKey(userId: string, projectId: string, revision: number): string {
  return `projects/${userId}/${projectId}/${revision}-${crypto.randomUUID()}.json`;
}

/** A stored payload R2 returned but JSON cannot read: no retry would change it. */
class CorruptCloudProjectError extends Error {
  constructor(objectKey: string, options?: ErrorOptions) {
    super(
      `Expected the cloud object '${objectKey}' to hold a JSON project record, but it could not be parsed.`,
      options,
    );
    this.name = "CorruptCloudProjectError";
  }
}

async function readStoredRecord(object: { text(): Promise<string> }, objectKey: string): Promise<unknown> {
  const text = await object.text();

  try {
    const record: unknown = JSON.parse(text);

    return record;
  } catch (cause) {
    throw new CorruptCloudProjectError(objectKey, { cause });
  }
}

/** What a save sends: the cloud revision it was based on, and the record. */
export const CloudSaveBodySchema = z.object({
  baseRevision: IntegerSchema.check(z.gte(0)),
  /** The content digest of the copy at `baseRevision`: a copy synced again at that revision is another copy. */
  baseDigest: z.optional(z.string()),
  record: z.optional(z.unknown()),
});

/**
 * A record the page can read back: a project record, with the official version it was forked from when it has one.
 * The page validates the manifest itself.
 */
const CloudProjectRecordSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  // D1 cannot store a name with a control character; such a record is refused rather than retried.
  name: z.string().check(
    z.minLength(1),
    z.maxLength(200),
    z.refine((name) => !hasControlCharacter(name)),
  ),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number(),
  manifest: FieldsSchema,
  trust: z.optional(z.unknown()),
  source: z.optional(ProjectSourceSchema),
});

/** The path of a synced project, such as `/api/cloud/projects/:id`. */
export const CloudProjectPathSchema = z.object({ id: UuidV4Schema });

/** The copy a delete removes, such as `?revision=3&digest=...`: a revision without leading zeros and its digest. */
export const CloudCopyQuerySchema = z.object({
  revision: z.pipe(z.string().check(z.regex(/^[1-9]\d{0,9}$/)), z.transform(Number)),
  digest: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
});

export const cloudProjectNotFound = {
  status: 404,
  code: "cloud_project_not_found",
  message: "This project is not synced to your account.",
} satisfies InputRefusal;
export const invalidCloudProjectId = {
  status: 400,
  code: "invalid_project_id",
  message: "This project cannot sync: its id is not a UUID.",
} satisfies InputRefusal;
export const invalidCloudSave = {
  status: 400,
  code: "invalid_base_revision",
  message: "Send the revision this save was based on.",
} satisfies InputRefusal;
export const invalidCloudDelete = {
  status: 400,
  code: "invalid_request",
  message: "Send the project id, and the revision and digest to remove.",
} satisfies InputRefusal;

type CloudContext = { user: SessionUser; bucket: CloudProjectBucket; repository: CloudRepository };

/** The signed-in user, the bucket and the repository, or the response that refuses the request. */
async function openCloud(
  request: Request,
  environment: WorkerEnvironment,
  services: CloudSyncServices,
): Promise<CloudContext | Response> {
  if (environment.CLOUD_PROJECTS === undefined) {
    return createApiError(503, "cloud_sync_unavailable", "Cloud sync is not set up on this deployment.");
  }

  const user = await services.currentUser(request, environment);

  if (user === null) {
    return createApiError(401, "sign_in_required", "Sign in with GitHub to sync projects.");
  }

  return { user, bucket: environment.CLOUD_PROJECTS, repository: services.repository(environment.PLAYGROUNDS) };
}

/**
 * Answers `GET /api/cloud`
 *
 * The signed-in user's synced projects and their usage against the limits. `githubId` names the account the projects belong to, so a page whose sign-in changed in
 * another tab never plans one account's sync state against another account's cloud.
 */
export async function readCloudStatus(
  request: Request,
  environment: WorkerEnvironment,
  services: CloudSyncServices,
): Promise<Response> {
  try {
    const cloud = await openCloud(request, environment, services);

    if (cloud instanceof Response) {
      return cloud;
    }

    const projects = await cloud.repository.listProjects(cloud.user.id);

    return Response.json(
      {
        githubId: cloud.user.githubId,
        limits: cloudSyncLimits,
        usage: {
          projects: projects.length,
          bytes: projects.reduce((total, entry) => total + entry.byteSize, 0),
        },
        projects: projects.map(toSummary),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (cause) {
    logWorkerFailure({
      event: "cloud_status_failed",
      cause,
      message: "Reading the cloud sync status failed",
      request,
    });
    return createApiError(503, "cloud_storage_unavailable", "Cloud sync could not be reached. Try again.");
  }
}

/**
 * Answers `GET /api/cloud/projects/:id`
 *
 * One synced project: its index entry and the stored record, for another machine to take.
 */
export async function readCloudProject(
  request: Request,
  environment: WorkerEnvironment,
  { id: projectId }: { id: string },
  services: CloudSyncServices,
): Promise<Response> {
  try {
    const cloud = await openCloud(request, environment, services);

    if (cloud instanceof Response) {
      return cloud;
    }

    const entry = await cloud.repository.findProject(cloud.user.id, projectId);
    const object = entry === null ? null : await cloud.bucket.get(entry.objectKey);

    if (entry === null || object === null) {
      return createApiError(404, "cloud_project_not_found", "This project is not synced to your account.");
    }

    return Response.json(
      { project: toSummary(entry), record: await readStoredRecord(object, entry.objectKey) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (cause) {
    logWorkerFailure({
      event: "cloud_read_failed",
      cause,
      message: "Reading a cloud project failed",
      request,
    });

    if (cause instanceof CorruptCloudProjectError) {
      return createApiError(500, "cloud_project_corrupt", "The cloud copy of this project cannot be read.");
    }

    return createApiError(503, "cloud_storage_unavailable", "Cloud sync could not be reached. Try again.");
  }
}

/**
 * The refusal for a save that would take the account past its project count or total bytes, or null within them
 *
 * `existing` is the entry the save replaces; it frees its bytes and takes no new project slot.
 */
function findStorageLimitError(
  totals: CloudTotals,
  existing: CloudProjectEntry | null,
  byteSize: number,
): Response | null {
  if (existing === null && totals.projects >= cloudSyncLimits.maxProjects) {
    return createApiError(403, "cloud_project_limit", "You sync 100 projects already, the limit.");
  }

  if (totals.bytes - (existing?.byteSize ?? 0) + byteSize > cloudSyncLimits.maxTotalBytes) {
    return createApiError(403, "cloud_storage_limit", "Your synced projects would pass 25 MB, the limit.");
  }

  return null;
}

/**
 * Answers `PUT /api/cloud/projects/:id`
 *
 * Saves the project as its next revision. The body names the revision it was based on (0 for a first save); a
 * different stored revision answers 409 with the stored entry, so the page asks which copy to keep. An unchanged
 * project writes nothing. Saves past a limit are refused, and the page keeps the work locally.
 *
 * The storage limits hold under concurrent saves: the index write checks the project count and bytes in its own WHERE.
 * Reads ahead of it only refuse early.
 *
 * ```text
 * checks ─► R2 put ─► guarded index write ─► saved: drop the replaced object
 *                       │ refused: drop the new object, 409 or 403
 *                       │ threw: drop the new object unless the index names it, 503
 * ```
 */
export async function saveCloudProject(
  request: Request,
  environment: WorkerEnvironment,
  { id: projectId, body }: { id: string; body: z.output<typeof CloudSaveBodySchema> },
  services: CloudSyncServices,
): Promise<Response> {
  try {
    const cloud = await openCloud(request, environment, services);

    if (cloud instanceof Response) {
      return cloud;
    }

    const rateLimit = await environment.CLOUD_SYNC_RATE_LIMIT?.limit({ key: `user:${cloud.user.id}` });

    if (rateLimit?.success === false) {
      return createApiError(429, "cloud_rate_limited", "Too many projects synced in the last minute.", {
        details: { retryAfterMs: saveRateLimitRetryAfterMs },
        headers: { "Retry-After": String(saveRateLimitRetryAfterMs / 1000) },
      });
    }

    // Check the project
    const { baseRevision, baseDigest, record } = body;
    const parsedRecord = CloudProjectRecordSchema.safeParse(record);

    if (!parsedRecord.success || parsedRecord.data.id !== projectId) {
      return createApiError(422, "invalid_project", "The project record is invalid.");
    }

    // The record is stored exactly as sent, so its bytes and key order stay the page's.
    const payload = JSON.stringify(record);
    const byteSize = textEncoder.encode(payload).byteLength;

    if (byteSize > cloudSyncLimits.maxProjectBytes) {
      return createApiError(413, "cloud_project_too_large", cloudProjectTooLargeMessage);
    }

    const digest = digestCloudProject(parsedRecord.data);
    const userId = cloud.user.id;
    const existing = await cloud.repository.findProject(userId, projectId);

    if (existing !== null && existing.contentDigest === digest) {
      return Response.json(
        { project: toSummary(existing), unchanged: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (
      (existing?.revision ?? 0) !== baseRevision ||
      (existing !== null && baseDigest !== undefined && existing.contentDigest !== baseDigest)
    ) {
      return createApiError(409, "cloud_conflict", "This project changed on another machine.", {
        details: { current: existing === null ? null : toSummary(existing) },
      });
    }

    // Check the limits
    const storageLimitError = findStorageLimitError(await cloud.repository.readTotals(userId), existing, byteSize);

    if (storageLimitError !== null) {
      return storageLimitError;
    }

    // Write the new revision, then point the index at it
    const now = services.now();
    const entry: CloudProjectEntry = {
      userId,
      projectId,
      name: parsedRecord.data.name,
      revision: baseRevision + 1,
      contentDigest: digest,
      byteSize,
      objectKey: createObjectKey(userId, projectId, baseRevision + 1),
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const storageLimits = {
      maxProjects: cloudSyncLimits.maxProjects,
      maxTotalBytes: cloudSyncLimits.maxTotalBytes,
    };

    await cloud.bucket.put(entry.objectKey, payload, { httpMetadata: { contentType: "application/json" } });

    let saved: boolean;

    try {
      saved =
        existing === null
          ? await cloud.repository.insertProject(entry, storageLimits)
          : await cloud.repository.updateProject(entry, { revision: baseRevision, digest: baseDigest }, storageLimits);
    } catch (cause) {
      // The write may have committed before failing to answer: keep the object only when the index names it. When the
      // index cannot be read either, the object stays, since an orphan is better than an index row without its object.
      const current = await cloud.repository.findProject(userId, projectId).catch((readCause: unknown) => {
        logWorkerFailure({
          event: "cloud_read_back_failed",
          cause: readCause,
          message: "Reading back a cloud project after its index write failed",
          request,
        });
        return undefined;
      });

      if (current !== undefined && current?.objectKey !== entry.objectKey) {
        await deleteCloudObject({ bucket: cloud.bucket, objectKey: entry.objectKey, request });
      }

      throw cause;
    }

    if (!saved) {
      // Another save won, or one saved meanwhile took the account to a limit. Each save writes its own key, so
      // deleting this one leaves the winner's.
      await deleteCloudObject({ bucket: cloud.bucket, objectKey: entry.objectKey, request });
      const current = await cloud.repository.findProject(userId, projectId);

      if ((current?.revision ?? 0) === baseRevision) {
        const limitError = findStorageLimitError(await cloud.repository.readTotals(userId), current, byteSize);

        if (limitError !== null) {
          return limitError;
        }
      }

      return createApiError(409, "cloud_conflict", "This project changed on another machine.", {
        details: { current: current === null ? null : toSummary(current) },
      });
    }

    if (existing !== null) {
      await deleteCloudObject({ bucket: cloud.bucket, objectKey: existing.objectKey, request });
    }

    return Response.json({ project: toSummary(entry), unchanged: false }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    logWorkerFailure({
      event: "cloud_save_failed",
      cause,
      message: "Saving a cloud project failed",
      request,
    });
    return createApiError(503, "cloud_storage_unavailable", "The project could not sync right now. Try again.");
  }
}

/**
 * Answers `DELETE /api/cloud/projects/:id?revision=N&digest=D`
 *
 * Removes the cloud copy of a project, as when sync is turned off for it or it is deleted. Only the copy the page last
 * saw is removed, by its revision and content: a newer one, or one synced again elsewhere at the same revision, answers
 * 409. Deleting is never limited: it frees space.
 */
export async function deleteCloudProject(
  request: Request,
  environment: WorkerEnvironment,
  { id: projectId, revision, digest }: { id: string } & z.output<typeof CloudCopyQuerySchema>,
  services: CloudSyncServices,
): Promise<Response> {
  try {
    const cloud = await openCloud(request, environment, services);

    if (cloud instanceof Response) {
      return cloud;
    }

    const copy = { revision, digest };
    const existing = await cloud.repository.findProject(cloud.user.id, projectId);

    if (existing === null) {
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    }

    if (
      existing.revision !== copy.revision ||
      existing.contentDigest !== copy.digest ||
      !(await cloud.repository.deleteProject(cloud.user.id, projectId, copy))
    ) {
      const current = await cloud.repository.findProject(cloud.user.id, projectId);

      return createApiError(409, "cloud_conflict", "This project changed on another machine.", {
        details: { current: current === null ? null : toSummary(current) },
      });
    }

    await deleteCloudObject({ bucket: cloud.bucket, objectKey: existing.objectKey, request });

    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    logWorkerFailure({
      event: "cloud_delete_failed",
      cause,
      message: "Deleting a cloud project failed",
      request,
    });
    return createApiError(503, "cloud_storage_unavailable", "The cloud copy could not be removed. Try again.");
  }
}

/** Deletes an object no index row names any more; a failure only leaves an orphan, so it is logged and skipped. */
async function deleteCloudObject({
  bucket,
  objectKey,
  request,
}: {
  bucket: CloudProjectBucket;
  objectKey: string;
  request: Request;
}): Promise<void> {
  try {
    await bucket.delete(objectKey);
  } catch (cause) {
    logWorkerFailure({
      event: "cloud_object_delete_failed",
      cause,
      message: "Deleting a cloud object failed",
      request,
    });
  }
}
