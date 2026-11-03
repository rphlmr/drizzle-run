import type { Executor, RunResult } from "@drizzle-run/core/contracts";
import { createComparisonController, createRunController } from "@drizzle-run/orchestration";
import { fakeRunResult, projectManifest } from "@drizzle-run/test-fixtures";
import { describe, expect, it, vi } from "vitest";

import { RunRefusedError, RunStoppedError, requestPairRun, requestRun } from "./run-request";

type RuntimeRun = ReturnType<Executor["createRun"]>;

/** A runtime whose runs settle when the test says so, or when cancelled. */
function makeRuntime() {
  const pending: { resolve: (result: RunResult) => void; cancel: ReturnType<typeof vi.fn> }[] = [];
  const runtime: Executor = {
    createRun: () => {
      const settled = Promise.withResolvers<RunResult>();
      const cancel = vi.fn(async () => settled.resolve(fakeRunResult("cancelled")));
      const run: RuntimeRun = {
        start: () => {},
        result: settled.promise,
        cancel,
        subscribe: () => ({ unsubscribe: () => {} }),
        subscribeEvent: () => ({ unsubscribe: () => {} }),
      };
      pending.push({ resolve: settled.resolve, cancel });

      return run;
    },
  };

  return { runtime, pending };
}

function makeInput(runtime: Executor) {
  return { runtime, submission: { manifest: projectManifest("sqlite"), revision: 1, debug: false } };
}

describe("requestRun", () => {
  it("should settle each waiter with its own run and refuse a second request while the first runs", async () => {
    const { runtime, pending } = makeRuntime();
    const execution = createRunController();

    const first = requestRun(execution, { requester: "guide", input: makeInput(runtime) });
    const second = requestRun(execution, { requester: "agent", input: makeInput(runtime) });
    pending[0]?.resolve(fakeRunResult("succeeded"));

    await expect(second).rejects.toBeInstanceOf(RunRefusedError);
    await expect(first).resolves.toMatchObject({ requester: "guide", outcome: "succeeded" });
    expect(pending).toHaveLength(1);
    await execution.dispose();
  });

  it("should cancel only its own run when its signal aborts, and forget the signal once settled", async () => {
    const { runtime, pending } = makeRuntime();
    const execution = createRunController();
    const earlier = new AbortController();
    const first = requestRun(execution, { requester: "guide", input: makeInput(runtime), signal: earlier.signal });
    pending[0]?.resolve(fakeRunResult("succeeded"));
    await first;

    const current = requestRun(execution, { requester: "view", input: makeInput(runtime) });
    earlier.abort();

    expect(pending[1]?.cancel).not.toHaveBeenCalled();
    pending[1]?.resolve(fakeRunResult("succeeded"));
    await expect(current).resolves.toMatchObject({ outcome: "succeeded" });
    await execution.dispose();
  });

  it("should cancel an active submission when disposed and refuse later submissions", async () => {
    const { runtime } = makeRuntime();
    const execution = createRunController();

    const waiting = requestRun(execution, { requester: "guide", input: makeInput(runtime) });
    await execution.dispose();

    await expect(waiting).resolves.toMatchObject({ outcome: "cancelled" });
    await expect(requestRun(execution, { requester: "guide", input: makeInput(runtime) })).rejects.toBeInstanceOf(
      RunStoppedError,
    );
  });
});

describe("requestPairRun", () => {
  it("should refuse a second request while both sides run", async () => {
    const sides = Promise.withResolvers<"succeeded">();
    const pairRun = createComparisonController({ runSide: () => sides.promise });

    const first = requestPairRun(pairRun, { requester: "guide" });
    const second = requestPairRun(pairRun, { requester: "agent" });
    sides.resolve("succeeded");

    await expect(second).rejects.toBeInstanceOf(RunRefusedError);
    await expect(first).resolves.toMatchObject({ outcomes: ["succeeded", "succeeded"] });
    await pairRun.dispose();
  });
});
