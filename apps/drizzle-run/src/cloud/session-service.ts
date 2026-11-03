import { CloudSyncError } from "./contract";
import type { CloudSession, CloudSessionStore, CloudSignOutInput, CloudSignOutResult } from "./session-contract";

/** A queued or running Cloud operation gets thirty seconds before cancellation is requested. */
export const cloudWorkflowTimeoutMs = 30_000;

/** The auth cookie is shared by every tab, so the lock is shared by every account and workspace. */
const cloudWorkflowLock = "drizzle-run-cloud-session";

interface CloudSessionDependencies {
  locks: Pick<LockManager, "request">;
  store: CloudSessionStore;
  flushProjects: () => Promise<void>;
  signOut: (signal: AbortSignal) => Promise<void>;
}

/** Coordinate sync and session cleanup without releasing a lock until its holder has stopped writing. */
export function createCloudSession({ locks, store, flushProjects, signOut }: CloudSessionDependencies): CloudSession {
  async function run<Result>(work: (signal: AbortSignal) => Promise<Result>, signal: AbortSignal): Promise<Result> {
    const deadline = new AbortController();
    const timeout = setTimeout(
      () => deadline.abort(new CloudSyncError("cloud_sync_timeout", "Cloud sync took too long. Try again.")),
      cloudWorkflowTimeoutMs,
    );
    const operationSignal = AbortSignal.any([signal, deadline.signal]);

    try {
      return await locks.request(cloudWorkflowLock, { signal: operationSignal }, async () => {
        operationSignal.throwIfAborted();
        const result = await work(operationSignal);
        operationSignal.throwIfAborted();

        return result;
      });
    } catch (cause) {
      operationSignal.throwIfAborted();
      throw cause;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function leave(input: CloudSignOutInput, signal: AbortSignal): Promise<CloudSignOutResult> {
    return run(async (operationSignal) => {
      await flushProjects();
      operationSignal.throwIfAborted();
      const result = await store.removeCloudProjects(input.githubId, input.policy);

      if (input.policy === "require_saved" && result.unsavedIds.length > 0) {
        return { kind: "unsaved", projectIds: result.unsavedIds };
      }

      operationSignal.throwIfAborted();
      await signOut(operationSignal);

      return { kind: "signed_out" };
    }, signal);
  }

  async function expire(githubId: number | null, signal: AbortSignal): Promise<void> {
    await run(async (operationSignal) => {
      await flushProjects();
      operationSignal.throwIfAborted();
      await store.removeCloudProjects(githubId, "keep_unsaved");
    }, signal);
  }

  return { run, signOut: leave, expire };
}
