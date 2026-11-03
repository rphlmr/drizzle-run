import * as z from "zod/mini";

import type { ProjectRecord } from "../project/projects";

/** A project id cloud sync takes: the Worker keys projects by UUID v4. */
export const CloudProjectIdSchema = z
  .string()
  .check(z.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));

/** What one account may sync, as the Worker enforces it (worker/cloud-sync.ts). */
export const CloudLimitsSchema = z.object({
  maxProjects: z.number(),
  maxProjectBytes: z.number(),
  maxTotalBytes: z.number(),
});

/** A synced project's index entry. */
export const CloudProjectSummarySchema = z.object({
  id: CloudProjectIdSchema,
  name: z.string(),
  revision: z.int().check(z.gte(1)),
  digest: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
  byteSize: z.number(),
  updatedAt: z.string(),
});

/** A synced project's index entry. */
export type CloudProjectSummary = z.output<typeof CloudProjectSummarySchema>;

/** `GET /api/cloud`: the signed-in account's cloud sync. */
export const CloudStatusSchema = z.object({
  /** GitHub's numeric id of the account these projects belong to. */
  githubId: z.int().check(z.gte(1)),
  limits: CloudLimitsSchema,
  usage: z.object({ projects: z.number(), bytes: z.number() }),
  projects: z.array(CloudProjectSummarySchema),
});

/** The signed-in account's cloud sync: its projects, usage and limits. */
export type CloudStatus = z.output<typeof CloudStatusSchema>;

/** `GET /api/cloud/projects/:id`: the record is validated as a project by the caller. */
export const CloudProjectResponseSchema = z.object({
  project: CloudProjectSummarySchema,
  record: z.optional(z.unknown()),
});

/** What a successful save answers. */
export const CloudSaveResponseSchema = z.object({
  project: CloudProjectSummarySchema,
  unchanged: z.boolean(),
});

const fallbackErrorCode = "cloud_storage_unavailable";
const fallbackErrorMessage = "Cloud sync could not be reached.";

/** A cloud sync error and the details its code comes with. Anything unreadable falls back to "unavailable". */
export const CloudErrorSchema = z.object({
  code: z.catch(z.string(), fallbackErrorCode),
  message: z.catch(z.string(), fallbackErrorMessage),
  retryAfterMs: z.catch(z.optional(z.number()), undefined),
  current: z.catch(z.nullable(CloudProjectSummarySchema), null),
});

/** A cloud sync error and the details its code comes with. */
export type CloudError = z.output<typeof CloudErrorSchema>;

/** The error to read when a failed response carries no readable error. */
export const unreadableCloudError: CloudError = {
  code: fallbackErrorCode,
  message: fallbackErrorMessage,
  current: null,
};

/** A failed cloud sync response's body. */
export const CloudErrorBodySchema = z.object({ error: CloudErrorSchema });

/** What a save came to. Anything not listed here throws a `CloudSyncError`. */
export type CloudSaveResult =
  | { kind: "saved"; project: CloudProjectSummary; unchanged: boolean }
  | { kind: "conflict"; current: CloudProjectSummary | null }
  /** The account's saves in the last minute: every other save would be refused too until `retryAfterMs`. */
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "too_large" }
  | { kind: "project_limit" }
  | { kind: "storage_limit" };

/** What removing a cloud copy came to. */
export type CloudDeleteResult = { kind: "deleted" } | { kind: "conflict"; current: CloudProjectSummary | null };

/** A cloud sync request that failed for a reason the sync cannot work around, with the Worker's error code. */
export class CloudSyncError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CloudSyncError";
    this.code = code;
  }
}

/** Save a project as the cloud revision after `baseRevision`. */
export interface SaveCloudProjectRequest {
  project: ProjectRecord;
  baseRevision: number;
  /** The content digest of the cloud copy at `baseRevision`, so a copy synced again at that revision is a conflict. */
  baseDigest?: string;
  /** Lets a save started as the page closes finish; the browser caps such bodies at 64 KiB. */
  keepalive?: boolean;
  signal: AbortSignal;
}

/** The cloud sync API of the signed-in account. */
export interface CloudService {
  /**
   * Read the signed-in account's cloud sync
   *
   * Throws a `CloudSyncError` with `sign_in_required` when the session ended, or `cloud_sync_unavailable` when the
   * deployment has no cloud bucket.
   */
  fetchCloudStatus(request: { signal: AbortSignal }): Promise<CloudStatus>;
  /** Read one synced project's record. The caller validates it as a project before using it. */
  fetchCloudProject(request: {
    id: string;
    signal: AbortSignal;
  }): Promise<{ project: CloudProjectSummary; record: unknown }>;
  /**
   * Save a project as the cloud revision after `baseRevision`
   *
   * Limits and conflicts come back as results, so the sync can keep the work local and say why.
   */
  saveCloudProject(request: SaveCloudProjectRequest): Promise<CloudSaveResult>;
  /**
   * Remove the cloud copy at `revision`
   *
   * Removes it only while its content is still the one `digest` names. A newer revision from another machine comes back
   * as a conflict.
   */
  deleteCloudProject(request: {
    id: string;
    revision: number;
    digest: string;
    signal: AbortSignal;
  }): Promise<CloudDeleteResult>;
}

const textEncoder = new TextEncoder();

/** Whether a project id can sync: the Worker keys projects by UUID v4. */
export function isSyncableProjectId(id: string): boolean {
  return CloudProjectIdSchema.safeParse(id).success;
}

/** The bytes a project takes in the cloud: its record as JSON. */
export function measureCloudProject(project: ProjectRecord): number {
  return textEncoder.encode(JSON.stringify(project)).byteLength;
}
