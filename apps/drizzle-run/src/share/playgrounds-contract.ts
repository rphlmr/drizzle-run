import type { PlaygroundSnapshot, RetiredPairSnapshot } from "@drizzle-run/core/contracts";
import type { RetiredPair } from "@drizzle-run/core/manifest";
import * as z from "zod/mini";

import { CommunityShareSchema } from "../community/contract";
import { TimestampSchema } from "../lib/api";

/** A shared link's id as the playground routes take it. */
export const PlaygroundIdSchema = z.string().check(z.regex(/^[A-Za-z0-9_-]{1,128}$/));

/** A snapshot's SHA-256, as lowercase hex. */
export const SnapshotDigestSchema = z.string().check(z.regex(/^[a-f0-9]{64}$/));

/** The UUID a publish attempt keeps across retries. */
export const IdempotencyKeySchema = z
  .string()
  .check(z.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i));

/** What a loaded link shows besides its snapshot. */
export const SharedLinkDetailsSchema = z.object({
  /** What the link shows, in one line, as its owner described it. */
  description: z.nullable(z.string()),
  /** The link's Community listing with who listed it; null when the link is not listed. */
  community: z._default(z.nullable(CommunityShareSchema), null),
});

/** What a loaded link shows besides its snapshot. */
export type SharedLinkDetails = z.output<typeof SharedLinkDetailsSchema>;

/** `GET /api/playgrounds/:id`: the snapshot is checked by core's snapshot parser, the rest here. */
export const SnapshotResponseSchema = z.object({
  snapshot: z.optional(z.unknown()),
  digest: SnapshotDigestSchema,
  updatedAt: TimestampSchema,
});

/** What a publish answers, before its links are checked against the app's origin. */
export const PublishResponseSchema = z.object({
  id: PlaygroundIdSchema,
  digest: SnapshotDigestSchema,
  updatedAt: TimestampSchema,
  url: z.string(),
  embedUrl: z.string(),
});

/** `GET /api/playgrounds/:id/ownership`. */
export const OwnershipResponseSchema = z.object({ owned: z.boolean() });

/** A Worker error's `{ code, message }` envelope, read as its code. */
export const PlaygroundErrorBodySchema = z.object({
  error: z.pipe(
    z.object({ code: z.string() }),
    z.transform(({ code }) => code),
  ),
});

/** A shared playground, with its snapshot and digest. */
export interface PublishedPlayground extends SharedLinkDetails {
  snapshot: PlaygroundSnapshot;
  digest: string;
  updatedAt: string;
}

/** A shared playground published on an ORM/Kit pair Drizzle Run no longer ships. */
export interface RetiredPairPlayground extends SharedLinkDetails {
  snapshot: RetiredPairSnapshot;
  retiredPair: RetiredPair;
  digest: string;
  updatedAt: string;
}

/** A loaded playground, on a pair still offered or a retired one. */
export type LoadedPlayground = PublishedPlayground | RetiredPairPlayground;

/** Whether the playground runs on a pair that is no longer offered. */
export function isRetiredPairPlayground(playground: LoadedPlayground): playground is RetiredPairPlayground {
  return "retiredPair" in playground;
}

/** The link a publish returns, with its links resolved on the app's origin. */
export interface PublishedPlaygroundLink {
  id: string;
  digest: string;
  updatedAt: string;
  url: string;
  embedUrl: string;
}

/** The link does not exist, as opposed to a failure worth retrying. */
export class PlaygroundNotFoundError extends Error {}

/** Load a shared link. */
export interface GetPlaygroundSnapshotRequest {
  id: string;
  signal: AbortSignal;
}

/** Publish a snapshot as a new link owned by the signed-in account. */
export interface PublishPlaygroundRequest {
  snapshot: PlaygroundSnapshot;
  /** An empty description publishes none. */
  description: string;
  /** A UUID kept across retries of the same publish. */
  idempotencyKey: string;
  signal: AbortSignal;
}

/** Replace what a link shows. */
export interface PushChangesRequest {
  linkId: string;
  snapshot: PlaygroundSnapshot;
  /** An empty description publishes none. */
  description: string;
  signal: AbortSignal;
}

/** Permanently delete a link with its recorded output and Community listing. */
export interface DeletePlaygroundRequest {
  linkId: string;
  signal: AbortSignal;
}

/** "deleted" when this request removed the link, "alreadyGone" when Drizzle Run no longer had it. */
export type DeletePlaygroundOutcome = "deleted" | "alreadyGone";

/** The shared playground API: loading, publishing and pushing changes to links. */
export interface PlaygroundsService {
  /** Load a shared link; throws `PlaygroundNotFoundError` when it does not exist. */
  getPlaygroundSnapshot(request: GetPlaygroundSnapshotRequest): Promise<LoadedPlayground>;
  /** Publish a snapshot as a new link; needs a signed-in session. */
  publishPlaygroundSnapshot(request: PublishPlaygroundRequest): Promise<PublishedPlaygroundLink>;
  /**
   * Replace what a link shows with `snapshot`
   *
   * Needs the signed-in session of the link's owner (the session cookie goes with every same-origin request). Pushing
   * the same code leaves the snapshot unchanged, so a retry is safe.
   */
  pushChanges(request: PushChangesRequest): Promise<PublishedPlaygroundLink>;
  /**
   * Whether the signed-in user owns a link
   *
   * False when signed out. A fork of an owned link keeps it, so its next share can publish to the same link from any
   * browser where the owner is signed in.
   */
  fetchLinkOwnership(request: { linkId: string; signal: AbortSignal }): Promise<boolean>;
  /**
   * Permanently delete a link, its recorded output and its Community listing
   *
   * Needs the owner's session, as `pushChanges` does. Resolves "alreadyGone" when the Worker answers that the link no longer
   * exists, so a retry after a lost answer settles; any other failure rejects.
   */
  deletePlayground(request: DeletePlaygroundRequest): Promise<DeletePlaygroundOutcome>;
}
