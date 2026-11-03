import { describe, expect, it, vi } from "vitest";

import { makeExecutionResult } from "../../test/quickjs/runner-fixture.ts";
import { runComparison } from "./comparison.ts";
import type { ExecutionResult, QuickjsRunner } from "./contract.ts";

describe("runComparison", () => {
  it("should forward planning and observation options to both children", async () => {
    const onMessage = vi.fn();
    const queryPlans = { size: "seed", measureRealTime: false } as const;
    const run = vi.fn(async () => makeExecutionResult());

    await runComparison({
      manifests: { a: {}, b: {} },
      createChild: () => ({ run, close() {} }),
      options: { queryPlans, onMessage },
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(1, {}, expect.objectContaining({ queryPlans, onMessage }));
    expect(run).toHaveBeenNthCalledWith(2, {}, expect.objectContaining({ queryPlans, onMessage }));
  });

  it("should abort child acquisition and settle cancellation when acquisition rejects", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const execution = runComparison({
      manifests: { a: {}, b: {} },
      createChild: (_manifest, signal) =>
        new Promise<QuickjsRunner>((_resolve, reject) => {
          started.resolve();
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      options: { signal: controller.signal, mode: "sequential" },
    });
    await started.promise;
    controller.abort();

    expect(await execution).toMatchObject({ a: { status: "cancelled" }, b: { status: "cancelled" } });
  });

  it("should deliver parallel sides independently after closing each child", async () => {
    const first = Promise.withResolvers<ExecutionResult>();
    const second = Promise.withResolvers<ExecutionResult>();
    const bothStarted = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    const order: string[] = [];
    let created = 0;
    const execution = runComparison({
      manifests: { a: {}, b: {} },
      createChild() {
        const side = created++ === 0 ? "a" : "b";

        return {
          run() {
            if (side === "b") {
              bothStarted.resolve();
            }

            return side === "a" ? first.promise : second.promise;
          },
          close() {
            order.push(`close:${side}`);
          },
        };
      },
      options: {
        onSide(side) {
          order.push(side);
          delivered.resolve();
        },
      },
    });
    await bothStarted.promise;
    second.resolve(makeExecutionResult());
    await delivered.promise;

    expect(order).toEqual(["close:b", "b"]);

    first.resolve(makeExecutionResult());
    const results = await execution;

    expect(results.a.status).toBe("success");
    expect(order).toEqual(["close:b", "b", "close:a", "a"]);
  });

  it("should wait for A's close before acquiring B even when A failed", async () => {
    const closing = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const order: string[] = [];
    let created = 0;
    const execution = runComparison({
      manifests: { a: {}, b: {} },
      createChild() {
        const side = created++ === 0 ? "a" : "b";
        order.push(`create:${side}`);

        return {
          run: async () =>
            side === "a" ? { status: "error", error: { phase: "run", message: "failed" } } : makeExecutionResult(),
          close() {
            if (side === "a") {
              closing.resolve();

              return closed.promise;
            }

            return undefined;
          },
        };
      },
      options: {
        mode: "sequential",
        onSide: (side) => {
          order.push(side);
        },
      },
    });
    await closing.promise;

    expect(created).toBe(1);

    closed.resolve();
    const results = await execution;

    expect(order).toEqual(["create:a", "a", "create:b", "b"]);
    expect(results.a.status).toBe("error");
    expect(results.b.status).toBe("success");
  });

  it("should cancel pending B without allocating it and wait for active A", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<AbortSignal | undefined>();
    const stopped = Promise.withResolvers<ExecutionResult>();
    const onSide = vi.fn();
    const createChild = vi.fn((): QuickjsRunner => ({
      run(_, options) {
        started.resolve(options?.signal);
        return stopped.promise;
      },
      close() {},
    }));
    const execution = runComparison({
      createChild,
      manifests: { a: {}, b: {} },
      options: { signal: controller.signal, mode: "sequential", onSide },
    });
    const signal = await started.promise;
    controller.abort();

    expect(signal?.aborted).toBe(true);
    expect(onSide).toHaveBeenCalledWith("b", expect.objectContaining({ status: "cancelled" }));
    expect(createChild).toHaveBeenCalledTimes(1);

    stopped.resolve({ status: "cancelled", workerTerminated: true, error: { phase: "run", message: "Run cancelled" } });
    const results = await execution;

    expect(results.a.workerTerminated).toBe(true);
    expect(results.b.workerTerminated).toBeUndefined();
  });

  it("should prevent B when A's result observer cancels", async () => {
    const controller = new AbortController();
    const createChild = vi.fn((): QuickjsRunner => ({ run: async () => makeExecutionResult(), close() {} }));

    const results = await runComparison({
      createChild,
      manifests: { a: {}, b: {} },
      options: { mode: "sequential", signal: controller.signal, onSide: () => controller.abort() },
    });

    expect(createChild).toHaveBeenCalledTimes(1);
    expect(results.a.status).toBe("success");
    expect(results.b.status).toBe("cancelled");
  });

  it("should close a child acquired after cancellation without starting it", async () => {
    const controller = new AbortController();
    const acquisition = Promise.withResolvers<QuickjsRunner>();
    const run = vi.fn(async () => makeExecutionResult());
    const close = vi.fn();
    const execution = runComparison({
      createChild: () => acquisition.promise,
      manifests: { a: {}, b: {} },
      options: { mode: "sequential", signal: controller.signal },
    });

    controller.abort();
    acquisition.resolve({ run, close });
    const results = await execution;

    expect(run).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(results.a.status).toBe("cancelled");
    expect(results.b.status).toBe("cancelled");
  });

  it("should allocate nothing when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const createChild = vi.fn((): QuickjsRunner => ({ run: async () => makeExecutionResult(), close() {} }));

    const results = await runComparison({
      createChild,
      manifests: { a: {}, b: {} },
      options: { signal: controller.signal },
    });

    expect(createChild).not.toHaveBeenCalled();
    expect(results.a.status).toBe("cancelled");
    expect(results.b.status).toBe("cancelled");
  });
});
