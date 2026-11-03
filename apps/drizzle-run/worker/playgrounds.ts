import {
  MAX_PLAYGROUND_SNAPSHOT_BYTES,
  parsePublishedPlaygroundSnapshot,
  type PlaygroundSnapshot,
  type PlaygroundSnapshotIssue,
  PlaygroundSnapshotValidationError,
  type PublishedPlaygroundSnapshot,
} from "@drizzle-run/core/contracts";
import { PAIR_SIDE_NAME_MAX_LENGTH } from "@drizzle-run/core/pair";
import * as z from "zod/mini";

import {
  createD1CommunityRepository,
  type CommunityRepository,
  type VisibleCommunityListing,
} from "./community-repository";
import { toCommunityShare } from "./community-share";
import { digestTextHex } from "./hex-digest";
import { checkRateLimit, createApiError, FieldsSchema, isNotModified, UuidV4Schema } from "./http";
import { maxListingTitleLength, toListingCopy } from "./listed-snapshot";
import { logWorkerFailure } from "./logger";
import { hasControlCharacter } from "./plain-text";
import type { WorkerEnvironment } from "./platform";
import type { ReadCurrentUser, SessionUser } from "./session";
import { createD1SnapshotRepository, type SnapshotRepository, type StoredPlaygroundLink } from "./snapshot-repository";
import { readSnapshotSummary, toSnapshotSummaryJson } from "./snapshot-summary";
import type { InputRefusal } from "./validation";

/** The largest snapshot body the worker accepts, in bytes. */
export const maxPlaygroundSnapshotBytes = MAX_PLAYGROUND_SNAPSHOT_BYTES;
/** The path of a link, such as `/api/playgrounds/:id`. */
export const LinkPathSchema = z.object({ id: UuidV4Schema });
const textEncoder = new TextEncoder();

/** What the playground routes depend on: ids, the clock, the repository and the session. */
export interface PlaygroundServices {
  newId(): string;
  now(): string;
  repository(database: WorkerEnvironment["PLAYGROUNDS"]): SnapshotRepository;
  /** The Community listings, read to show who listed a link. */
  listings(database: WorkerEnvironment["PLAYGROUNDS"]): CommunityRepository;
  /** The signed-in user, or null. */
  currentUser(request: Request, environment: WorkerEnvironment): Promise<SessionUser | null>;
}

/** The playground services the Worker runs with: random ids, the clock, the session and D1. */
export function createD1PlaygroundServices({ currentUser }: { currentUser: ReadCurrentUser }): PlaygroundServices {
  return {
    newId: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
    repository: createD1SnapshotRepository,
    listings: createD1CommunityRepository,
    currentUser,
  };
}

/** The headers of a new link's publish: the attempt's idempotency key. */
export const PublishHeadersSchema = z.pipe(
  z.object({ "idempotency-key": z.string().check(z.regex(/^[A-Za-z0-9._~-]{16,128}$/)) }),
  z.transform((headers) => ({ idempotencyKey: headers["idempotency-key"] })),
);

export const playgroundNotFound = {
  status: 404,
  code: "playground_not_found",
  message: "This shared playground does not exist.",
} satisfies InputRefusal;
export const invalidIdempotencyKey = {
  status: 400,
  code: "invalid_idempotency_key",
  message: "Provide a 16 to 128 character idempotency key for this publish attempt.",
} satisfies InputRefusal;

/** The longest share description, in characters. The Community listing reuses it. */
export const maxShareDescriptionLength = 140;

/**
 * What D1 keeps for a row beyond its text columns: ids, timestamps, digests, index entries and page slack. Rounded up,
 * so the counted total stays above what D1 holds.
 */
export const storedRowOverheadBytes = 512;

/** The UTF-8 bytes of the text columns a write stores, plus `rows` times the row overhead. */
export function measureStoredBytes({ texts, rows }: { texts: readonly (string | null)[]; rows: number }): number {
  let bytes = rows * storedRowOverheadBytes;

  for (const text of texts) {
    bytes += text === null ? 0 : textEncoder.encode(text).byteLength;
  }

  return bytes;
}

/** The most UTF-8 bytes one character takes. */
const maxUtf8BytesPerCharacter = 4;

/**
 * The room a Community listing's texts may take, whatever snapshot it shows: its title, description and two side names
 * at their longest, so a push with a longer name stays counted.
 */
export const listingTextRoomBytes =
  (maxListingTitleLength + maxShareDescriptionLength + 2 * PAIR_SIDE_NAME_MAX_LENGTH) * maxUtf8BytesPerCharacter;

/**
 * What a link counts once, beyond its snapshot's texts: its own row, and the row and text room of the Community listing
 * it may get, listed or not
 */
export const newLinkRowsBytes = measureStoredBytes({ texts: [], rows: 2 }) + listingTextRoomBytes;

/**
 * A snapshot's texts: its payload, summary and description, and the file names a Community listing copies from it, as
 * a JSON array of the summary's paths
 */
export function measureSnapshotBytes(prepared: Pick<PreparedSnapshot, "payloadJson" | "summaryJson" | "description">) {
  const listedFileNames = JSON.stringify(Object.keys(readSnapshotSummary(prepared.summaryJson).files));

  return measureStoredBytes({
    texts: [prepared.payloadJson, prepared.summaryJson, prepared.description, listedFileNames],
    rows: 0,
  });
}

/** A new link: its snapshot's texts, the link's row, and the row and texts of the Community listing it may get. */
export function measureNewLinkBytes(prepared: PreparedSnapshot): number {
  return measureSnapshotBytes(prepared) + newLinkRowsBytes;
}

export interface PreparedSnapshot {
  snapshot: PlaygroundSnapshot;
  payloadJson: string;
  contentDigest: string;
  /** Community's and link previews' view of the snapshot; see `toSnapshotSummaryJson`. */
  summaryJson: string;
  description: string | null;
}

/**
 * The bytes shares and recorded runs may keep in D1 in total when `PUBLISH_MAX_STORED_BYTES` is
 * missing or invalid. It stays under the Free plan's 500 MB database, leaving room for accounts, Community listings and
 * cloud sync records. Nothing is deleted to make room: past it, publishing pauses until the cap is raised.
 */
export const defaultMaxStoredPublishBytes = 400 * 1000 * 1000; // 400 MB

const ByteBudgetSchema = z.pipe(z.string().check(z.trim(), z.regex(/^\d+$/)), z.transform(Number));

function resolveByteBudget(value: string | undefined, fallback: number): number {
  const budget = ByteBudgetSchema.safeParse(value);

  return budget.success ? budget.data : fallback;
}

/** Bytes counted toward the stored total: give them back with `release` when the publish stored nothing. */
export interface ReservedPublishBytes {
  release(): Promise<void>;
}

/**
 * Count a publish's stored bytes toward the stored total
 *
 * Once the total would pass `PUBLISH_MAX_STORED_BYTES`, answers 503 `publish_storage_full` until the cap is raised;
 * `"0"` pauses publishing. Otherwise returns the reservation, whose `release` gives the bytes back.
 */
export async function reservePublishBytes({
  repository,
  environment,
  bytes,
  request,
}: {
  repository: Pick<SnapshotRepository, "reservePublishBytes" | "releasePublishBytes">;
  environment: WorkerEnvironment;
  bytes: number;
  request?: Request;
}): Promise<Response | ReservedPublishBytes> {
  const reserved = await repository.reservePublishBytes({
    bytes,
    storedBudget: resolveByteBudget(environment.PUBLISH_MAX_STORED_BYTES, defaultMaxStoredPublishBytes),
  });

  if (!reserved) {
    return createApiError(
      503,
      "publish_storage_full",
      "Publishing is paused: Drizzle Run has no room left for new shares or recorded runs. Your project stays in this browser.",
    );
  }

  return {
    release: async () => {
      // Best effort: a failed release only leaves the total a little high.
      try {
        await repository.releasePublishBytes(bytes);
      } catch (cause) {
        logWorkerFailure({
          event: "publish_bytes_release_failed",
          cause,
          message: "Giving back unused publish bytes failed",
          request,
        });
      }
    },
  };
}

/** An optional share description: trimmed to one line, null when empty. The Community listing reuses it. */
export const ShareDescriptionSchema = z.pipe(
  z.nullish(z.string({ error: "A description must be text." })),
  z.transform((text, context) => {
    const normalized = (text ?? "").trim().replace(/\s+/g, " ");

    if (hasControlCharacter(normalized)) {
      context.issues.push({
        code: "custom",
        message: "A description must be plain text, without control characters.",
        input: text,
      });
      return z.NEVER;
    }

    if (normalized.length > maxShareDescriptionLength) {
      context.issues.push({
        code: "custom",
        message: `A description must be at most ${maxShareDescriptionLength} characters.`,
        input: text,
      });
      return z.NEVER;
    }

    return normalized === "" ? null : normalized;
  }),
);

/** The body of a publish or a push: the snapshot, checked by the route, and its description. */
export const ShareBodySchema = z.object(
  { snapshot: z.optional(z.unknown()), description: ShareDescriptionSchema },
  { error: "Send the share as { snapshot, description }." },
);

/** The largest publish body, in bytes: the snapshot wrapped with a short description. */
export const maxPublishBodyBytes = maxPlaygroundSnapshotBytes + 4096;

/**
 * Prepare a publish its route has read
 *
 * Checks the rate limit, then the snapshot's version and validity. A signed-in publish counts for `userId` instead of
 * the address.
 */
async function preparePublish({
  request,
  environment,
  body,
  userId,
}: {
  request: Request;
  environment: WorkerEnvironment;
  body: z.output<typeof ShareBodySchema>;
  userId: string | null;
}): Promise<PreparedSnapshot | Response> {
  const rateLimitResponse = await checkRateLimit(request, environment, "publish", { userId });

  if (rateLimitResponse !== undefined) {
    return rateLimitResponse;
  }

  const unsupported = checkSnapshotVersion(body.snapshot);

  if (unsupported !== undefined) {
    return createApiError(422, "unsupported_version", unsupported);
  }

  let published: PublishedPlaygroundSnapshot;

  try {
    published = parsePublishedPlaygroundSnapshot(body.snapshot);
  } catch (cause) {
    return toSnapshotValidationError(cause);
  }

  return {
    snapshot: published.snapshot,
    payloadJson: published.canonicalJson,
    contentDigest: published.digest,
    summaryJson: await toSnapshotSummaryJson(published.snapshot),
    description: body.description,
  };
}

/**
 * Read the signed-in user a share change needs
 *
 * Answers 401 `sign_in_required` with `signInMessage` when signed out, and 503 when the session cannot be read.
 */
export async function requireSignedInUser({
  request,
  environment,
  sessions,
  signInMessage,
}: {
  request: Request;
  environment: WorkerEnvironment;
  /** Reads the session behind `request`. */
  sessions: { currentUser: ReadCurrentUser };
  signInMessage: string;
}): Promise<SessionUser | Response> {
  let user: SessionUser | null;

  try {
    user = await sessions.currentUser(request, environment);
  } catch (cause) {
    logWorkerFailure({
      event: "share_session_failed",
      cause,
      message: "Checking the session for a share failed",
      request,
    });
    return createApiError(503, "session_unavailable", "Your session could not be checked right now. Try again.");
  }

  return user ?? createApiError(401, "sign_in_required", signInMessage);
}

/** The link when `user` owns it; a 404 or 403 response otherwise. */
export async function authorizeLinkOwner({
  id,
  user,
  links,
}: {
  id: string;
  user: SessionUser;
  links: Pick<SnapshotRepository, "findLink">;
}): Promise<StoredPlaygroundLink | Response> {
  const link = await links.findLink(id);

  if (link === null) {
    return createApiError(404, "playground_not_found", "This shared playground does not exist.");
  }

  return checkLinkOwner(link, user);
}

function checkLinkOwner(link: StoredPlaygroundLink, user: SessionUser): StoredPlaygroundLink | Response {
  return link.ownerUserId === user.id
    ? link
    : createApiError(403, "not_link_owner", "This share belongs to another GitHub account.");
}

/** What a new link's publish sends, as its route reads it. */
export interface ShareInput {
  idempotencyKey: string;
  body: z.output<typeof ShareBodySchema>;
}

/**
 * Answers `POST /api/playgrounds`: publishes a snapshot as a new link of the signed-in user, once per idempotency key
 */
export async function publishPlayground(
  request: Request,
  environment: WorkerEnvironment,
  { idempotencyKey, body }: ShareInput,
  services: PlaygroundServices,
): Promise<Response> {
  const owner = await requireSignedInUser({
    request,
    environment,
    sessions: services,
    signInMessage: "Sign in with GitHub to share.",
  });

  if (owner instanceof Response) {
    return owner;
  }

  const prepared = await preparePublish({ request, environment, body, userId: owner.id });

  if (prepared instanceof Response) {
    return prepared;
  }

  const repository = services.repository(environment.PLAYGROUNDS);

  try {
    // A retry with the same idempotency key stores nothing new, so only a first attempt counts its bytes.
    let reserved: ReservedPublishBytes | undefined;

    if ((await repository.findByIdempotencyKey(idempotencyKey)) === null) {
      const reservation = await reservePublishBytes({
        repository,
        environment,
        bytes: measureNewLinkBytes(prepared),
        request,
      });

      if (reservation instanceof Response) {
        return reservation;
      }

      reserved = reservation;
    }

    const id = services.newId();

    // An insert that throws may still have landed, so its bytes stay counted: a total a little high only pauses
    // publishing sooner, where one too low could fill D1.
    await repository.insertLinkIfNew({
      id,
      ownerUserId: owner.id,
      snapshotVersion: prepared.snapshot.snapshotVersion,
      payloadJson: prepared.payloadJson,
      contentDigest: prepared.contentDigest,
      description: prepared.description,
      summaryJson: prepared.summaryJson,
      idempotencyKey,
      createdAt: services.now(),
    });

    const stored = await repository.findByIdempotencyKey(idempotencyKey);

    // A concurrent first attempt with the same key stored its row instead, so this one added nothing. A row that
    // cannot be read back may still have landed, so its bytes stay counted.
    if (stored !== null && stored.id !== id) {
      await reserved?.release();
    }

    if (stored === null) {
      return createApiError(
        503,
        "snapshot_storage_unavailable",
        "The published playground could not be read back yet.",
      );
    }

    if (
      stored.contentDigest !== prepared.contentDigest ||
      stored.payloadJson !== prepared.payloadJson ||
      stored.description !== prepared.description ||
      stored.ownerUserId !== owner.id
    ) {
      return createApiError(
        409,
        "idempotency_key_conflict",
        "This idempotency key was already used for a different playground.",
      );
    }

    return publishResponse(stored);
  } catch (cause) {
    logWorkerFailure({
      event: "publish_failed",
      cause,
      message: "Publishing a playground failed",
      request,
    });
    return createApiError(
      503,
      "snapshot_storage_unavailable",
      "The playground could not be published. Retry with the same idempotency key.",
    );
  }
}

/** What a push sends, as its route reads it. */
export interface PushInput {
  id: string;
  body: z.output<typeof ShareBodySchema>;
}

/**
 * Answers `PUT /api/playgrounds/:id`: replaces the link's snapshot and description, for its signed-in owner
 *
 * The link and its Community listing show the new code at once, and a recorded run of other code goes. Pushing what the
 * link already shows leaves its snapshot unchanged.
 */
export async function pushChanges(
  request: Request,
  environment: WorkerEnvironment,
  { id, body }: PushInput,
  services: PlaygroundServices,
): Promise<Response> {
  const user = await requireSignedInUser({
    request,
    environment,
    sessions: services,
    signInMessage: "Sign in with the GitHub account that shared this link to push changes.",
  });

  if (user instanceof Response) {
    return user;
  }

  const prepared = await preparePublish({ request, environment, body, userId: user.id });

  if (prepared instanceof Response) {
    return prepared;
  }

  const repository = services.repository(environment.PLAYGROUNDS);

  try {
    const link = await repository.findLink(id);

    if (link === null) {
      return createApiError(404, "playground_not_found", "This shared playground does not exist.");
    }

    const owner = checkLinkOwner(link, user);

    if (owner instanceof Response) {
      return owner;
    }

    if (link.payloadJson === prepared.payloadJson && link.description === prepared.description) {
      return publishResponse(link);
    }

    const reserved = await reservePublishBytes({
      repository,
      environment,
      bytes: measureSnapshotBytes(prepared),
      request,
    });

    if (reserved instanceof Response) {
      return reserved;
    }

    // A push that throws may still have landed, so its bytes stay counted.
    const updated = await repository.pushSnapshot(
      id,
      {
        snapshotVersion: prepared.snapshot.snapshotVersion,
        payloadJson: prepared.payloadJson,
        contentDigest: prepared.contentDigest,
        description: prepared.description,
        summaryJson: prepared.summaryJson,
        updatedAt: services.now(),
      },
      toListingCopy(prepared.summaryJson),
      { rowOverheadBytes: storedRowOverheadBytes },
    );

    if (!updated) {
      await reserved.release();
      return createApiError(404, "playground_not_found", "This shared playground does not exist.");
    }

    const pushed = await repository.findLink(id);

    // Deletion after a committed push already gives back the new snapshot's bytes.
    if (pushed === null) {
      return createApiError(404, "playground_not_found", "This shared playground does not exist.");
    }

    return publishResponse(pushed);
  } catch (cause) {
    logWorkerFailure({
      event: "push_failed",
      cause,
      message: "Pushing changes to a playground failed",
      request,
    });
    return createApiError(503, "snapshot_storage_unavailable", "The changes could not be pushed. Try again.");
  }
}

/**
 * Answers `GET /api/playgrounds/:id`: the link's snapshot, with its description and Community listing
 *
 * Revalidated on every load, since a push or a listing change can replace what it shows.
 */
export async function readPlayground(
  request: Request,
  environment: WorkerEnvironment,
  { id }: { id: string },
  services: PlaygroundServices,
): Promise<Response> {
  let link: StoredPlaygroundLink | null;
  let listing: VisibleCommunityListing | null;

  try {
    [link, listing] = await Promise.all([
      services.repository(environment.PLAYGROUNDS).findLink(id),
      services.listings(environment.PLAYGROUNDS).findVisible(id),
    ]);
  } catch (cause) {
    logWorkerFailure({
      event: "playground_read_failed",
      cause,
      message: "Loading a playground failed",
      request,
    });
    return createApiError(503, "snapshot_storage_unavailable", "The shared playground could not be loaded right now.");
  }

  if (link === null) {
    return createApiError(404, "playground_not_found", "This shared playground does not exist.");
  }

  const community = listing === null ? null : toCommunityShare(listing, listing.owner);
  const communityTag = community === null ? "" : `-c${(await digestTextHex(JSON.stringify(community))).slice(0, 16)}`;
  const etag = `"sha256-${link.contentDigest}-u${Date.parse(link.updatedAt)}${communityTag}"`;
  const headers = new Headers({
    "Cache-Control": "no-cache",
    "Content-Type": "application/json; charset=utf-8",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  });

  if (isNotModified(request, etag)) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(
    JSON.stringify({
      snapshot: JSON.parse(link.payloadJson),
      digest: link.contentDigest,
      updatedAt: link.updatedAt,
      description: link.description,
      community,
    }),
    { headers },
  );
}

/**
 * Answers `GET /api/playgrounds/:id/ownership`: whether the signed-in user owns the link
 *
 * A fork of an owned link on another machine uses it to push changes to the same link. Signed out, the answer is always
 * false.
 */
export async function readOwnership(
  request: Request,
  environment: WorkerEnvironment,
  { id }: { id: string },
  services: PlaygroundServices,
): Promise<Response> {
  try {
    const user = await services.currentUser(request, environment);
    const link = await services.repository(environment.PLAYGROUNDS).findLink(id);

    if (link === null) {
      return createApiError(404, "playground_not_found", "This shared playground does not exist.");
    }

    return Response.json(
      { owned: user !== null && link.ownerUserId === user.id },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (cause) {
    logWorkerFailure({
      event: "playground_read_failed",
      cause,
      message: "Loading a playground failed",
      request,
    });
    return createApiError(503, "snapshot_storage_unavailable", "The shared playground could not be loaded right now.");
  }
}

/** What a share's deletion sends, as its route reads it. */
export interface DeleteShareInput {
  id: string;
}

/**
 * Answers `DELETE /api/playgrounds/:id`: deletes a link for good, for its signed-in owner
 *
 * Its snapshot, recorded run and Community listing go with it, and the bytes they counted go back to the
 * stored total. Projects and accounts stay; copies already downloaded cannot be recalled.
 */
export async function deleteShare(
  request: Request,
  environment: WorkerEnvironment,
  { id }: DeleteShareInput,
  services: PlaygroundServices,
): Promise<Response> {
  const user = await requireSignedInUser({
    request,
    environment,
    sessions: services,
    signInMessage: "Sign in with the GitHub account that shared this link to stop sharing it.",
  });

  if (user instanceof Response) {
    return user;
  }

  try {
    const repository = services.repository(environment.PLAYGROUNDS);
    const owner = await authorizeLinkOwner({ id, user, links: repository });

    if (owner instanceof Response) {
      return owner;
    }

    await repository.deleteLink(id, { rowOverheadBytes: storedRowOverheadBytes, linkBytes: newLinkRowsBytes });

    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    logWorkerFailure({
      event: "share_delete_failed",
      cause,
      message: "Deleting a share failed",
      request,
    });
    return createApiError(503, "snapshot_storage_unavailable", "The share could not be deleted right now. Try again.");
  }
}

// A version that is present must be 1; a missing one is left for the snapshot parser to report.
const SupportedSnapshotVersionSchema = z.object({ snapshotVersion: z.optional(z.literal(1)) });
const SupportedManifestVersionSchema = z.object({ manifestVersion: z.optional(z.literal(1)) });

/** Why a snapshot's format is unsupported, or undefined when its versions are 1 or it is not an object at all. */
function checkSnapshotVersion(value: unknown): string | undefined {
  const snapshot = FieldsSchema.safeParse(value);

  if (!snapshot.success) {
    return undefined;
  }

  if (!SupportedSnapshotVersionSchema.safeParse(snapshot.data).success) {
    return "This snapshot format is not supported.";
  }

  const manifest = FieldsSchema.safeParse(snapshot.data.manifest);

  if (manifest.success && !SupportedManifestVersionSchema.safeParse(manifest.data).success) {
    return "This manifest version is not supported.";
  }

  return undefined;
}

function toSnapshotValidationError(error: unknown): Response {
  const issues = readIssues(error);

  if (issues.some(({ code }) => code === "UNSUPPORTED_VERSION")) {
    return createApiError(422, "unsupported_version", "This snapshot or manifest version is not supported.");
  }

  if (issues.some(({ code }) => code === "SNAPSHOT_TOO_LARGE")) {
    return createApiError(
      413,
      "snapshot_too_large",
      "A published playground must be at most 1 MiB after canonical serialization.",
    );
  }

  return Response.json(
    {
      error: {
        code: "invalid_snapshot",
        message: "The playground snapshot is invalid.",
        issues,
      },
    },
    { status: 422, headers: { "Cache-Control": "no-store" } },
  );
}

/** The issues core's snapshot validation threw, or none for any other failure. */
function readIssues(error: unknown): readonly PlaygroundSnapshotIssue[] {
  return error instanceof PlaygroundSnapshotValidationError ? error.issues : [];
}

function publishResponse(stored: StoredPlaygroundLink): Response {
  return Response.json(
    {
      id: stored.id,
      digest: stored.contentDigest,
      updatedAt: stored.updatedAt,
      url: `/s/${stored.id}`,
      embedUrl: `/embed/${stored.id}`,
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
