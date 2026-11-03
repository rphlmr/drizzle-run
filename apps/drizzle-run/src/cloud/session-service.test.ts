import { setImmediate } from "node:timers/promises";
import { locks } from "node:worker_threads";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CloudSessionStore } from "./session-contract";
import { cloudWorkflowTimeoutMs, createCloudSession } from "./session-service";

function makeSession() {
  const removeCloudProjects = vi.fn<CloudSessionStore["removeCloudProjects"]>(async () => ({
    removedIds: [],
    unsavedIds: [],
  }));
  const signOut = vi.fn<(signal: AbortSignal) => Promise<void>>(async () => {});
  const flushProjects = vi.fn(async () => {});
  const session = createCloudSession({ locks, store: { removeCloudProjects }, signOut, flushProjects });

  return { session, removeCloudProjects, signOut, flushProjects };
}

function makeSignal() {
  return new AbortController().signal;
}

describe("createCloudSession", () => {
  afterEach(() => vi.useRealTimers());

  it("should wait for an active cycle and hold the lock through cleanup and server sign-out", async () => {
    const firstTab = makeSession();
    const otherTab = makeSession();
    const cycleStarted = Promise.withResolvers<void>();
    const finishCycle = Promise.withResolvers<void>();
    const logoutStarted = Promise.withResolvers<void>();
    const finishLogout = Promise.withResolvers<void>();
    firstTab.signOut.mockImplementation(async () => {
      logoutStarted.resolve();
      await finishLogout.promise;
    });
    const cycle = otherTab.session.run(async () => {
      cycleStarted.resolve();
      await finishCycle.promise;
    }, makeSignal());
    await cycleStarted.promise;

    const leaving = firstTab.session.signOut({ githubId: 1, policy: "require_saved" }, makeSignal());
    await setImmediate();
    expect(firstTab.removeCloudProjects).not.toHaveBeenCalled();
    finishCycle.resolve();
    await cycle;
    await logoutStarted.promise;

    const nextCycle = vi.fn(async () => {});
    const waiting = otherTab.session.run(nextCycle, makeSignal());
    await setImmediate();
    expect(firstTab.removeCloudProjects).toHaveBeenCalledWith(1, "require_saved");
    expect(nextCycle).not.toHaveBeenCalled();
    finishLogout.resolve();

    await expect(leaving).resolves.toEqual({ kind: "signed_out" });
    await waiting;
    expect(nextCycle).toHaveBeenCalledOnce();
  });

  it("should cancel a stalled request through its actual signal before a waiting sign-out removes projects", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const holder = makeSession();
    const requester = makeSession();
    const started = Promise.withResolvers<AbortSignal>();
    const cycle = holder.session.run(
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          started.resolve(signal);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      makeSignal(),
    );
    const outcome = cycle.catch((cause: unknown) => cause);
    const requestSignal = await started.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    const leaving = requester.session.signOut({ githubId: 1, policy: "require_saved" }, makeSignal());

    await vi.advanceTimersByTimeAsync(cloudWorkflowTimeoutMs - 1_000);
    expect(await outcome).toMatchObject({ code: "cloud_sync_timeout" });
    await expect(leaving).resolves.toEqual({ kind: "signed_out" });

    expect(requestSignal.aborted).toBe(true);
    expect(requester.removeCloudProjects).toHaveBeenCalledOnce();
  });

  it("should time out a queued sign-out without stealing a lock from work that ignores cancellation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const holder = makeSession();
    const requester = makeSession();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const lateWrite = vi.fn();
    const cycle = holder.session.run(async (signal) => {
      started.resolve();
      await release.promise;
      signal.throwIfAborted();
      lateWrite();
    }, makeSignal());
    const cycleOutcome = cycle.catch((cause: unknown) => cause);
    await started.promise;
    const leaving = requester.session.signOut({ githubId: 1, policy: "require_saved" }, makeSignal());
    const leaveOutcome = leaving.catch((cause: unknown) => cause);

    await vi.advanceTimersByTimeAsync(cloudWorkflowTimeoutMs);
    expect(await leaveOutcome).toMatchObject({ code: "cloud_sync_timeout" });
    expect(requester.removeCloudProjects).not.toHaveBeenCalled();
    expect(requester.signOut).not.toHaveBeenCalled();
    expect((await locks.query()).held).toHaveLength(1);

    release.resolve();
    expect(await cycleOutcome).toMatchObject({ code: "cloud_sync_timeout" });
    expect(lateWrite).not.toHaveBeenCalled();
  });

  it("should leave unsaved projects and the session untouched until the owner confirms", async () => {
    const { session, removeCloudProjects, signOut } = makeSession();
    removeCloudProjects.mockResolvedValue({ removedIds: [], unsavedIds: ["edited"] });

    await expect(session.signOut({ githubId: 1, policy: "require_saved" }, makeSignal())).resolves.toEqual({
      kind: "unsaved",
      projectIds: ["edited"],
    });
    expect(signOut).not.toHaveBeenCalled();

    await expect(session.signOut({ githubId: 1, policy: "discard" }, makeSignal())).resolves.toEqual({
      kind: "signed_out",
    });
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("should flush edits and preserve them as Local on expiry without calling logout", async () => {
    const { session, removeCloudProjects, signOut, flushProjects } = makeSession();

    await session.expire(null, makeSignal());

    expect(flushProjects).toHaveBeenCalledOnce();
    expect(removeCloudProjects).toHaveBeenCalledWith(null, "keep_unsaved");
    expect(signOut).not.toHaveBeenCalled();
  });
});
