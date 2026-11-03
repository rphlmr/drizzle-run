import type {
  ComparisonHandle,
  ComparisonManifest,
  CreateComparisonOptions,
  RunHandle,
  RunResult,
} from "@drizzle-run/core/contracts";
import { fakeRunResult } from "@drizzle-run/test-fixtures";
import { vi } from "vitest";

/** An SDK comparison whose side results and cancellation cleanup remain under the test's control. */
export function makeRuntimeComparison() {
  const results = { a: Promise.withResolvers<RunResult>(), b: Promise.withResolvers<RunResult>() };
  const cleanup = Promise.withResolvers<void>();
  const unsubscribe = vi.fn();
  const dispose = vi.fn(async () => {});
  const start = vi.fn();
  let cancellation: Promise<void> | undefined;
  const cancel = vi.fn(() => {
    cancellation ??= cleanup.promise.then(() => {
      results.a.resolve(fakeRunResult("cancelled"));
      results.b.resolve(fakeRunResult("cancelled"));

      return undefined;
    });

    return cancellation;
  });

  function createSide(side: "a" | "b"): Pick<RunHandle, "result" | "subscribe" | "subscribeEvent"> {
    return {
      result: results[side].promise,
      subscribe(listener) {
        listener({ state: "idle", status: "active", sequence: 0, elapsedMs: 0 });

        return { unsubscribe };
      },
      subscribeEvent: () => ({ unsubscribe }),
    };
  }

  const comparison: ComparisonHandle = {
    sides: { a: createSide("a"), b: createSide("b") },
    result: Promise.all([results.a.promise, results.b.promise]).then(([a, b]) => ({ a, b })),
    start,
    cancel,
  };
  function handleAbort() {
    void cancel();
  }

  const createComparison = vi.fn((_manifests: ComparisonManifest, options?: CreateComparisonOptions) => {
    options?.signal?.addEventListener("abort", handleAbort, { once: true });
    void comparison.result.then(() => options?.signal?.removeEventListener("abort", handleAbort));

    return comparison;
  });

  return { runtime: { createComparison, dispose }, results, cleanup, start, cancel, unsubscribe };
}
