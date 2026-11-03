import type { Fetch } from "../lib/api";
import {
  CloudErrorBodySchema,
  CloudProjectResponseSchema,
  CloudSaveResponseSchema,
  CloudStatusSchema,
  CloudSyncError,
  unreadableCloudError,
  type CloudError,
  type CloudService,
} from "./contract";

/** What cloud sync needs: the network and the origin it runs on. */
export interface CloudServiceDependencies {
  /** Sends every request; the browser's `fetch` in the app, a fake in tests. */
  fetch: Fetch;
  /** The Drizzle Run origin requests go to, such as `https://drizzle.run`. */
  origin: string;
}

async function readError(response: Response): Promise<CloudError> {
  const parsed = CloudErrorBodySchema.safeParse(await response.json().catch(() => null));

  return parsed.success ? parsed.data.error : unreadableCloudError;
}

function toInvalidResponseError(): CloudSyncError {
  return new CloudSyncError("invalid_response", "Cloud sync answered with something unexpected.");
}

/** Create the cloud sync API, sending every request to `origin`. */
export function createCloudService({ fetch, origin }: CloudServiceDependencies): CloudService {
  const toUrl = (path: string) => new URL(path, origin).href;

  return {
    async fetchCloudStatus({ signal }) {
      const response = await fetch(toUrl("/api/cloud"), { headers: { Accept: "application/json" }, signal });

      if (!response.ok) {
        const error = await readError(response);
        throw new CloudSyncError(error.code, error.message);
      }

      const parsed = CloudStatusSchema.safeParse(await response.json());

      if (!parsed.success) {
        throw toInvalidResponseError();
      }

      return parsed.data;
    },

    async fetchCloudProject({ id, signal }) {
      const response = await fetch(toUrl(`/api/cloud/projects/${id}`), {
        headers: { Accept: "application/json" },
        signal,
      });

      if (!response.ok) {
        const error = await readError(response);
        throw new CloudSyncError(error.code, error.message);
      }

      const parsed = CloudProjectResponseSchema.safeParse(await response.json());

      if (!parsed.success || parsed.data.project.id !== id) {
        throw toInvalidResponseError();
      }

      return { project: parsed.data.project, record: parsed.data.record };
    },

    async saveCloudProject({ project, baseRevision, baseDigest, keepalive = false, signal }) {
      const response = await fetch(toUrl(`/api/cloud/projects/${project.id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ baseRevision, ...(baseDigest === undefined ? {} : { baseDigest }), record: project }),
        keepalive,
        signal,
      });

      if (response.ok) {
        const parsed = CloudSaveResponseSchema.safeParse(await response.json());

        if (!parsed.success) {
          throw toInvalidResponseError();
        }

        return { kind: "saved", project: parsed.data.project, unchanged: parsed.data.unchanged };
      }

      const error = await readError(response);

      switch (error.code) {
        case "cloud_conflict":
          return { kind: "conflict", current: error.current };
        case "cloud_rate_limited":
          return { kind: "rate_limited", retryAfterMs: error.retryAfterMs ?? 60_000 };
        case "cloud_project_too_large":
          return { kind: "too_large" };
        case "cloud_project_limit":
          return { kind: "project_limit" };
        case "cloud_storage_limit":
          return { kind: "storage_limit" };
        default:
          throw new CloudSyncError(error.code, error.message);
      }
    },

    async deleteCloudProject({ id, revision, digest, signal }) {
      const query = new URLSearchParams({ revision: String(revision), digest });
      const response = await fetch(toUrl(`/api/cloud/projects/${id}?${query}`), {
        method: "DELETE",
        signal,
      });

      if (response.ok) {
        return { kind: "deleted" };
      }

      const error = await readError(response);

      if (error.code === "cloud_conflict") {
        return { kind: "conflict", current: error.current };
      }

      throw new CloudSyncError(error.code, error.message);
    },
  };
}
