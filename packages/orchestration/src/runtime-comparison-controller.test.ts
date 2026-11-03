import type {
  ComparisonHandle,
  CreateComparisonOptions,
  QueryPlansSettings,
  RunResult,
  Runtime,
} from "@drizzle-run/core/contracts";
import { pairSide } from "@drizzle-run/core/pair";
import { fakeRunResult } from "@drizzle-run/test-fixtures";
import { pairManifest } from "@drizzle-run/test-fixtures/pair";
import { describe, expect, it, vi } from "vitest";

import { createRunController } from "./run-controller.ts";
import { createRuntimeComparisonController } from "./runtime-comparison-controller.ts";

function makeComparison({ automatic = true, aggregate }: { automatic?: boolean; aggregate?: Promise<void> } = {}) {
  const results = { a: Promise.withResolvers<RunResult>(), b: Promise.withResolvers<RunResult>() };
  const subscribed = vi.fn();
  const sides = Object.fromEntries(
    Object.entries(results).map(([side, result]) => [
      side,
      {
        result: result.promise,
        subscribe: () => {
          subscribed();
          return { unsubscribe() {} };
        },
        subscribeEvent: () => ({ unsubscribe() {} }),
      },
    ]),
  );
  const start = vi.fn(() => {
    expect(subscribed).toHaveBeenCalledTimes(2);
    if (automatic) {
      results.a.resolve(fakeRunResult("succeeded"));
      results.b.resolve(fakeRunResult("succeeded"));
    }
  });
  const cancel = vi.fn(async () => {
    results.a.resolve(fakeRunResult("cancelled"));
    results.b.resolve(fakeRunResult("cancelled"));
  });
  const comparison: ComparisonHandle = {
    sides: { a: sides.a, b: sides.b },
    start,
    cancel,
    result: Promise.all([results.a.promise, results.b.promise]).then(async ([a, b]) => {
      await aggregate;

      return { a, b };
    }),
  };

  return { comparison, subscribed, start, cancel, results };
}

describe("createRuntimeComparisonController", () => {
  it("should publish both histories independently and await aggregate cleanup before disposal", async () => {
    const manifest = pairManifest();
    const cleanup = Promise.withResolvers<void>();
    const controlled = makeComparison({ aggregate: cleanup.promise });
    const histories = [createRunController(), createRunController()];
    const controller = createRuntimeComparisonController({
      getRuntime: () => ({ createComparison: () => controlled.comparison }),
      getManifest: () => manifest,
      runSide: ({ side, runtime, signal }) =>
        histories[side].submit({ manifest: pairSide(manifest, side), revision: 1, debug: false }, { runtime, signal }),
    });
    const settled = vi.fn();
    const submitted = controller.submit().then(settled);

    try {
      await vi.waitFor(() => expect(histories.every((history) => history.getState().history.length === 1)).toBe(true));

      expect(controller.getState().runs.map((run) => run?.outcome)).toEqual(["succeeded", "succeeded"]);
      expect(controller.getState().status).toBe("running");
      expect(settled).not.toHaveBeenCalled();

      const disposed = vi.fn();
      const closing = controller.dispose().then(disposed);
      await Promise.resolve();
      expect(controller.getState().status).toBe("disposing");
      expect(disposed).not.toHaveBeenCalled();

      cleanup.resolve();
      await Promise.all([submitted, closing]);
      expect(settled).toHaveBeenCalledOnce();
      expect(controller.getState().status).toBe("disposed");
    } finally {
      cleanup.resolve();
      await controller.dispose();
      await Promise.all(histories.map((history) => history.dispose()));
    }
  });

  it("should reject aggregate cleanup failure and preserve independently delivered side results", async () => {
    const manifest = pairManifest();
    const cleanup = Promise.withResolvers<void>();
    const failure = new Error("Comparison cleanup failed");
    const controlled = makeComparison({ aggregate: cleanup.promise });
    const histories = [createRunController(), createRunController()];
    const controller = createRuntimeComparisonController({
      getRuntime: () => ({ createComparison: () => controlled.comparison }),
      getManifest: () => manifest,
      runSide: ({ side, runtime, signal }) =>
        histories[side].submit({ manifest: pairSide(manifest, side), revision: 1, debug: false }, { runtime, signal }),
    });
    const submitted = controller.submit().catch((cause: unknown) => cause);
    await vi.waitFor(() => expect(histories.every((history) => history.getState().history.length === 1)).toBe(true));
    const cancelling = controller.cancel().catch((cause: unknown) => cause);
    const disposing = controller.dispose().catch((cause: unknown) => cause);

    cleanup.reject(failure);

    expect(await submitted).toBe(failure);
    expect(await cancelling).toBe(failure);
    expect(await disposing).toBe(failure);
    expect(controller.getState()).toMatchObject({ status: "failed", error: failure.message });
    expect(controller.getState().runs.map((run) => run?.outcome)).toEqual(["succeeded", "succeeded"]);
    await expect(controller.dispose()).rejects.toBe(failure);
    await Promise.all(histories.map((history) => history.dispose()));
  });

  it("should use the captured pair for execution and history after runtime acquisition", async () => {
    let manifest = pairManifest();
    const captured = structuredClone(manifest);
    const acquisition = Promise.withResolvers<Pick<Runtime, "createComparison">>();
    const controlled = makeComparison();
    const createComparison = vi.fn(() => controlled.comparison);
    const histories = [createRunController(), createRunController()];
    const controller = createRuntimeComparisonController({
      getRuntime: () => acquisition.promise,
      getManifest: () => manifest,
      runSide: ({ side, runtime, signal, manifest: requested }) =>
        histories[side].submit(
          { manifest: pairSide(requested ?? manifest, side), revision: 1, debug: false },
          { runtime, signal },
        ),
    });
    const submitted = controller.submit();
    manifest = structuredClone(manifest);
    manifest.sides[0].files["query.ts"] = "newer query";
    acquisition.resolve({ createComparison });
    await submitted;

    expect(createComparison).toHaveBeenCalledWith(
      { a: pairSide(captured, 0), b: pairSide(captured, 1) },
      expect.anything(),
    );
    expect(histories[0].getState().history[0]?.submission.manifest).toEqual(pairSide(captured, 0));
    expect(histories[1].getState().history[0]?.submission.manifest).toEqual(pairSide(captured, 1));
    await controller.dispose();
    await Promise.all(histories.map((history) => history.dispose()));
  });

  it("should cancel during runtime acquisition without attaching histories or creating a comparison", async () => {
    const manifest = pairManifest();
    const acquisition = Promise.withResolvers<Pick<Runtime, "createComparison">>();
    const createComparison = vi.fn(() => makeComparison().comparison);
    const histories = [createRunController(), createRunController()];
    const runSide = vi.fn(({ side, runtime, signal }) =>
      histories[side].submit({ manifest: pairSide(manifest, side), revision: 1, debug: false }, { runtime, signal }),
    );
    const controller = createRuntimeComparisonController({
      getRuntime: () => acquisition.promise,
      getManifest: () => manifest,
      runSide,
    });
    const submitted = controller.submit();
    const cancelling = controller.cancel();
    acquisition.resolve({ createComparison });

    expect((await submitted).outcomes).toEqual(["cancelled", "cancelled"]);
    await cancelling;
    expect(createComparison).not.toHaveBeenCalled();
    expect(runSide).not.toHaveBeenCalled();
    expect(histories.every((history) => history.getState().history.length === 0)).toBe(true);
    await controller.dispose();
    await Promise.all(histories.map((history) => history.dispose()));
  });

  it("should publish A independently without cancelling B and propagate explicit request cancellation", async () => {
    const manifest = pairManifest();
    const controlled = makeComparison({ automatic: false });
    const histories = [createRunController(), createRunController()];
    const settled = [vi.fn(), vi.fn()];
    histories.forEach((history, side) => history.onSettled(settled[side]));
    const createComparison = vi.fn((_manifests, options?: CreateComparisonOptions) => {
      options?.signal?.addEventListener("abort", () => void controlled.comparison.cancel(), { once: true });

      return controlled.comparison;
    });
    const controller = createRuntimeComparisonController({
      getRuntime: () => ({ createComparison }),
      getManifest: () => manifest,
      runSide: ({ side, runtime, signal }) =>
        histories[side].submit({ manifest: pairSide(manifest, side), revision: 1, debug: true }, { runtime, signal }),
    });
    const submitted = controller.submit();
    await vi.waitFor(() => expect(controlled.start).toHaveBeenCalledOnce());
    controlled.results.a.resolve(fakeRunResult("succeeded"));
    await vi.waitFor(() => expect(settled[0]).toHaveBeenCalledOnce());

    expect(histories[1].getState().status).toBe("running");
    expect(settled[1]).not.toHaveBeenCalled();
    expect(controlled.cancel).not.toHaveBeenCalled();
    expect(createComparison.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);

    await controller.cancel();
    const outcome = await submitted;

    expect(outcome.outcomes).toEqual(["succeeded", "cancelled"]);
    expect(settled[1]).toHaveBeenCalledOnce();
    expect(controlled.cancel).toHaveBeenCalled();
    await controller.dispose();
    await Promise.all(histories.map((history) => history.dispose()));
  });

  it("should allow a new comparison after runtime acquisition fails", async () => {
    const controlled = makeComparison();
    const getRuntime = vi
      .fn()
      .mockRejectedValueOnce(new Error("Runtime unavailable"))
      .mockResolvedValue({ createComparison: () => controlled.comparison });
    const controller = createRuntimeComparisonController({
      getRuntime,
      getManifest: () => pairManifest(),
      runSide: async () => "cancelled",
    });

    const failed = await controller.submit();
    const recovered = await controller.submit();

    expect(failed.outcomes).toEqual(["failed", "failed"]);
    expect(recovered.outcomes).toEqual(["cancelled", "cancelled"]);
    expect(getRuntime).toHaveBeenCalledTimes(2);
    await controller.dispose();
  });

  it("should attach both history controllers before starting one SDK comparison and capture current query plans", async () => {
    const manifest = pairManifest();
    const controlled = makeComparison();
    const createComparison = vi.fn((_manifests, _options?: CreateComparisonOptions) => controlled.comparison);
    const histories = [createRunController(), createRunController()];
    let queryPlans: QueryPlansSettings | undefined;
    const controller = createRuntimeComparisonController({
      getRuntime: () => ({ createComparison }),
      getManifest: () => manifest,
      getQueryPlans: () => queryPlans,
      execution: "sequential",
      runSide: ({ side, runtime, signal }) =>
        histories[side].submit({ manifest: pairSide(manifest, side), revision: 1, debug: true }, { runtime, signal }),
    });
    queryPlans = { size: "10k", measureRealTime: true };

    const outcome = await controller.submit();

    expect(createComparison).toHaveBeenCalledOnce();
    expect(createComparison.mock.calls[0]?.[1]).toMatchObject({ execution: "sequential", queryPlans });
    expect(controlled.start).toHaveBeenCalledOnce();
    expect(outcome.outcomes).toEqual(["succeeded", "succeeded"]);
    expect(histories.every((history) => history.getState().history.length === 1)).toBe(true);
    await controller.dispose();
    await Promise.all(histories.map((history) => history.dispose()));
  });

  it("should cancel the SDK comparison when an observer refuses its side before attachment", async () => {
    const controlled = makeComparison();
    const controller = createRuntimeComparisonController({
      getRuntime: () => ({ createComparison: () => controlled.comparison }),
      getManifest: () => pairManifest(),
      runSide: async () => "cancelled",
    });

    await controller.submit();

    expect(controlled.start).not.toHaveBeenCalled();
    expect(controlled.cancel).toHaveBeenCalled();
    await controller.dispose();
  });
});
