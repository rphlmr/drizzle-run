import type { Executor, RunResult } from "@drizzle-run/core/contracts";
import { fakeRunResult, projectManifest } from "@drizzle-run/test-fixtures";
import { describe, expect, it, vi } from "vitest";

import { createRunController, createComparisonController, RunRefusedError, RunStoppedError } from "./index.ts";

function makeSubmission() {
  return { manifest: projectManifest("sqlite"), revision: 1, debug: false };
}

function makeControlledRuntime() {
  const result = Promise.withResolvers<RunResult>();
  const cleanup = Promise.withResolvers<void>();
  const cancel = vi.fn(async () => {
    await cleanup.promise;
    result.resolve(fakeRunResult("cancelled"));
  });
  const createRun = vi.fn(() => ({
    result: result.promise,
    start() {},
    cancel,
    subscribe: () => ({ unsubscribe() {} }),
    subscribeEvent: () => ({ unsubscribe() {} }),
  }));
  const runtime: Executor = { createRun };

  return { runtime, result, cleanup, cancel, createRun };
}

describe("run controller", () => {
  it.each(["succeeded", "failed", "cancelled"] as const)(
    "should expose a plain %s outcome and history",
    async (outcome) => {
      const controlled = makeControlledRuntime();
      const runs = createRunController({ runtime: controlled.runtime });
      const changed = vi.fn();
      const settled = vi.fn();
      const subscription = runs.subscribe(changed);
      runs.onSettled(settled);
      const firstState = runs.getState();

      expect(runs.getState()).toBe(firstState);
      const pending = runs.submit(makeSubmission());
      expect(runs.getState().status).toBe("running");
      controlled.result.resolve(fakeRunResult(outcome));
      const result = await pending;

      expect(result.outcome).toBe(outcome);
      expect(result).not.toHaveProperty("type");
      expect(settled).toHaveBeenCalledWith(result);
      expect(runs.getState().history).toHaveLength(1);
      expect(runs.getState()).not.toHaveProperty("context");
      expect(changed).toHaveBeenCalled();
      subscription.unsubscribe();
      const count = changed.mock.calls.length;
      await runs.dispose();
      expect(changed).toHaveBeenCalledTimes(count);
    },
  );

  it("should refuse a concurrent submission without cancelling the accepted run", async () => {
    const controlled = makeControlledRuntime();
    const runs = createRunController({ runtime: controlled.runtime });
    const first = runs.submit(makeSubmission());
    const rejectedSignal = new AbortController();

    await expect(runs.submit(makeSubmission(), { signal: rejectedSignal.signal })).rejects.toBeInstanceOf(
      RunRefusedError,
    );
    rejectedSignal.abort();
    expect(controlled.cancel).not.toHaveBeenCalled();
    controlled.result.resolve(fakeRunResult("succeeded"));
    await first;
    await runs.dispose();
  });

  it("should wait for cancellation cleanup before disposal and refuse submissions while disposing", async () => {
    const controlled = makeControlledRuntime();
    const runs = createRunController({ runtime: controlled.runtime });
    const pending = runs.submit(makeSubmission());
    const disposed = vi.fn();
    const closing = runs.dispose().then(disposed);
    const closingAgain = runs.dispose();

    expect(controlled.cancel).toHaveBeenCalledOnce();

    expect(runs.getState().status).toBe("disposing");
    expect(disposed).not.toHaveBeenCalled();
    await expect(runs.submit(makeSubmission())).rejects.toBeInstanceOf(RunStoppedError);
    controlled.cleanup.resolve();
    await Promise.all([closing, closingAgain]);

    await expect(pending).resolves.toMatchObject({ outcome: "cancelled" });
    expect(runs.getState().status).toBe("disposed");
    await runs.dispose();
    await runs.cancel();
    expect(() => runs.replay({ submission: makeSubmission(), result: fakeRunResult("succeeded") })).toThrow(
      RunStoppedError,
    );
  });

  it("should cancel only the submitted request and remove its abort listener after settlement", async () => {
    const controlled = makeControlledRuntime();
    const runs = createRunController();
    const abort = new AbortController();
    const pending = runs.submit(makeSubmission(), { runtime: controlled.runtime, signal: abort.signal });
    abort.abort();
    expect(controlled.cancel).toHaveBeenCalledOnce();
    controlled.cleanup.resolve();
    await pending;
    await runs.dispose();
  });

  it("should reject an already aborted submission without creating a run", async () => {
    const controlled = makeControlledRuntime();
    const runs = createRunController({ runtime: controlled.runtime });
    const cause = new Error("aborted");

    await expect(runs.submit(makeSubmission(), { signal: AbortSignal.abort(cause) })).rejects.toBe(cause);
    expect(controlled.createRun).not.toHaveBeenCalled();
    await runs.dispose();
  });

  it("should cancel a preparation and preserve the previously selected history entry", async () => {
    const controlled = makeControlledRuntime();
    const runs = createRunController({ runtime: controlled.runtime });
    runs.replay({ submission: makeSubmission(), result: fakeRunResult("succeeded") });
    runs.replay({ submission: { ...makeSubmission(), revision: 2 }, result: fakeRunResult("failed") });
    runs.selectHistoryEntry(1);
    let signal: AbortSignal | undefined;
    const pending = runs.submit(makeSubmission(), {
      prepare: (value) => {
        signal = value;
        return new Promise(() => {});
      },
    });

    await runs.cancel();
    await expect(pending).resolves.toMatchObject({ outcome: "cancelled" });
    expect(signal?.aborted).toBe(true);
    expect(controlled.createRun).not.toHaveBeenCalled();
    expect(runs.getState().selectedHistoryEntry).toBe(1);
    await runs.dispose();
  });

  it("should report a missing executor without leaving a request pending", async () => {
    const runs = createRunController();
    await expect(runs.submit(makeSubmission())).rejects.toThrow("Provide a runtime");
    expect(runs.getState().status).toBe("idle");
    await runs.cancel();
    await runs.dispose();
  });

  it("should settle an executor failure and accept a later submission", async () => {
    const runs = createRunController({
      runtime: {
        createRun() {
          throw new Error("cannot create run");
        },
      },
    });
    await expect(runs.submit(makeSubmission())).resolves.toMatchObject({
      outcome: "failed",
      error: "cannot create run",
    });
    const controlled = makeControlledRuntime();
    controlled.result.resolve(fakeRunResult("succeeded"));
    await expect(runs.submit(makeSubmission(), { runtime: controlled.runtime })).resolves.toMatchObject({
      outcome: "succeeded",
    });
    await runs.dispose();
  });
});

describe("comparison controller", () => {
  it.each([0, 1] as const)("should preserve a thrown side %s error with that side", async (failedSide) => {
    const failure = new Error(`Side ${failedSide} runtime unavailable`);
    const comparison = createComparisonController({
      async runSide({ side }) {
        if (side === failedSide) {
          throw failure;
        }

        return "succeeded";
      },
    });

    const result = await comparison.submit();

    expect(result.runs[failedSide]).toEqual({ outcome: "failed", error: failure.message });
    expect(result.runs[failedSide === 0 ? 1 : 0]).toEqual({ outcome: "succeeded" });
    expect(comparison.getState().runs[failedSide]).toEqual({ outcome: "failed", error: failure.message });
    await comparison.dispose();
  });

  it("should preserve sequential scheduling through a plain API", async () => {
    const calls: number[] = [];
    const comparison = createComparisonController({
      execution: "sequential",
      runSide: async ({ side }) => {
        calls.push(side);
        return "succeeded";
      },
    });
    const settled = vi.fn();
    comparison.onSettled(settled);
    const result = await comparison.submit();

    expect(calls).toEqual([0, 1]);
    expect(result.outcomes).toEqual(["succeeded", "succeeded"]);
    expect(result).not.toHaveProperty("type");
    expect(settled).toHaveBeenCalledWith(result);
    await comparison.cancel();
    await comparison.dispose();
    await comparison.dispose();
  });

  it("should cancel the active side, skip the waiting side, and wait before disposing", async () => {
    const cleanup = Promise.withResolvers<void>();
    const calls: number[] = [];
    const comparison = createComparisonController({
      execution: "sequential",
      runSide: async ({ side, signal }) => {
        calls.push(side);
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        await cleanup.promise;
        return "cancelled";
      },
    });
    const subscription = comparison.subscribe(vi.fn());
    const pending = comparison.submit();
    const disposing = comparison.dispose();

    expect(comparison.getState().status).toBe("disposing");
    await expect(comparison.submit()).rejects.toBeInstanceOf(RunStoppedError);
    cleanup.resolve();
    await disposing;
    expect((await pending).outcomes).toEqual(["cancelled", "cancelled"]);
    expect(calls).toEqual([0]);
    expect(comparison.getState().status).toBe("disposed");
    subscription.unsubscribe();
  });
});
