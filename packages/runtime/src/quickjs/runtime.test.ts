import { describe, expect, it, vi } from "vitest";

import { makeExecutionManifest } from "../../test/quickjs/execution-fixture.ts";
import { makeExecutionAssets, makeExecutionResult, makeExecutionWorker } from "../../test/quickjs/runner-fixture.ts";
import { makeRuntimeDependencies } from "../../test/quickjs/runtime-fixture.ts";
import { createRunner as createExecutionRunner } from "./runner.ts";
import { createQuickjsRuntime } from "./runtime.ts";

describe("createQuickjsRuntime", () => {
  it("should await both comparison cleanup attempts before rejecting a failed cleanup", async () => {
    const releasing = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const failure = new Error("Comparison A cleanup failed");
    let next = 0;
    const runtime = createQuickjsRuntime(
      makeRuntimeDependencies({
        createRunner: async () => {
          const side = next++;

          return {
            run: async () => makeExecutionResult(),
            async close() {
              if (side === 0) {
                throw failure;
              }

              releasing.resolve();
              await released.promise;
            },
          };
        },
      }),
    );
    const manifest = makeExecutionManifest();
    const comparison = runtime.createComparison({ a: manifest, b: manifest });
    const rejected = vi.fn();
    const completion = comparison.result.catch(rejected);
    comparison.start();
    await releasing.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(rejected).not.toHaveBeenCalled();
    released.resolve();
    await completion;

    expect(rejected).toHaveBeenCalledOnce();
    await expect(runtime.dispose()).rejects.toThrow("Comparison A cleanup failed");
  });

  it("should await comparison cancellations and its own cleanup before rejecting disposal", async () => {
    const childReleasing = Promise.withResolvers<void>();
    const childReleased = Promise.withResolvers<void>();
    const parentReleasing = Promise.withResolvers<void>();
    const parentReleased = Promise.withResolvers<void>();
    let next = 0;
    const runtime = createQuickjsRuntime(
      makeRuntimeDependencies({
        createRunner: async () => {
          const owner = next++;

          return {
            run: async () => makeExecutionResult(),
            async close() {
              if (owner === 0) {
                parentReleasing.resolve();
                await parentReleased.promise;
              } else if (owner === 1) {
                throw new Error("Comparison child cleanup failed");
              } else {
                childReleasing.resolve();
                await childReleased.promise;
              }
            },
          };
        },
      }),
    );
    const manifest = makeExecutionManifest();
    await runtime.prepare(manifest);
    const comparison = runtime.createComparison({ a: manifest, b: manifest });
    const comparisonCompletion = comparison.result.catch(() => {});
    comparison.start();
    await childReleasing.promise;
    const rejected = vi.fn();
    const disposal = runtime.dispose().catch(rejected);
    await parentReleasing.promise;
    childReleased.resolve();
    await comparisonCompletion;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(rejected).not.toHaveBeenCalled();
    parentReleased.resolve();
    await disposal;

    expect(rejected).toHaveBeenCalledOnce();
  });

  it("should settle a run and reject disposal when the host termination contract fails", async () => {
    const runtime = createQuickjsRuntime(
      makeRuntimeDependencies({
        preparation: "on_demand",
        createRunner: async () =>
          createExecutionRunner({
            assets: makeExecutionAssets(),
            createWorker: () =>
              makeExecutionWorker({
                terminate: async () => {
                  throw new Error("Host cleanup failed");
                },
              }),
          }),
      }),
    );
    const handle = runtime.createRun(makeExecutionManifest());
    handle.start();
    const result = await handle.result;

    expect(result.outcome).toBe("failed");
    expect(result.error?.code).toBe("cleanup_failed");
    expect(result.cleanupErrors).toHaveLength(2);
    await expect(runtime.dispose()).rejects.toThrow("cleanup failed");
  });

  it("should retain cleanup failure evidence when an aborted run settles", async () => {
    const running = Promise.withResolvers<void>();
    const controller = new AbortController();
    const runtime = createQuickjsRuntime(
      makeRuntimeDependencies({
        createRunner: async () => ({
          async run(_manifest, options) {
            running.resolve();
            await new Promise<void>((resolve) =>
              options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
            );

            return {
              status: "error",
              error: { phase: "cleanup", code: "cleanup_failed", message: "Host cleanup failed" },
              cleanup: {
                guest: { mode: "forced", reason: "host_termination_failed" },
                database: { mode: "forced", reason: "host_termination_failed" },
              },
            };
          },
          close() {},
        }),
      }),
    );
    const handle = runtime.createRun(makeExecutionManifest(), { signal: controller.signal });
    handle.start();
    await running.promise;
    controller.abort();
    const result = await handle.result;

    expect(result.outcome).toBe("cancelled");
    expect(result.cleanupErrors).toHaveLength(2);
    await runtime.dispose();
  });
  it("should publish a comparison side independently and await both sides for aggregate completion", async () => {
    const results = [
      Promise.withResolvers<ReturnType<typeof makeExecutionResult>>(),
      Promise.withResolvers<ReturnType<typeof makeExecutionResult>>(),
    ];
    let next = 0;
    const close = vi.fn();
    const createRunner = vi.fn(async () => {
      const result = results[next++];

      return { run: () => result.promise, close };
    });
    const runtime = createQuickjsRuntime(makeRuntimeDependencies({ createRunner }));
    const manifest = makeExecutionManifest();
    const comparison = runtime.createComparison({ a: manifest, b: manifest });
    const completed = vi.fn();
    void comparison.result.then(completed);
    comparison.start();
    await vi.waitFor(() => expect(createRunner).toHaveBeenCalledTimes(2));

    results[0].resolve(makeExecutionResult());
    await comparison.sides.a.result;
    expect(completed).not.toHaveBeenCalled();
    results[1].resolve(makeExecutionResult());
    await comparison.result;

    expect(close).toHaveBeenCalledTimes(2);
    expect(completed).toHaveBeenCalledOnce();
    await runtime.dispose();
  });

  it("should release sequential comparison A before allocating B", async () => {
    const releasing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let next = 0;
    const createRunner = vi.fn(async () => {
      const side = next++;

      return {
        run: async () => makeExecutionResult(),
        async close() {
          if (side === 0) {
            releasing.resolve();
            await release.promise;
          }
        },
      };
    });
    const runtime = createQuickjsRuntime(makeRuntimeDependencies({ createRunner }));
    const manifest = makeExecutionManifest();
    const comparison = runtime.createComparison({ a: manifest, b: manifest }, { execution: "sequential" });
    comparison.start();
    await releasing.promise;

    expect(createRunner).toHaveBeenCalledOnce();
    release.resolve();
    await comparison.result;

    expect(createRunner).toHaveBeenCalledTimes(2);
    await runtime.dispose();
  });

  it("should cancel an idle comparison without allocating either execution", async () => {
    const createRunner = vi.fn(async () => ({ run: async () => makeExecutionResult(), close() {} }));
    const runtime = createQuickjsRuntime(makeRuntimeDependencies({ createRunner }));
    const manifest = makeExecutionManifest();
    const comparison = runtime.createComparison({ a: manifest, b: manifest });

    await comparison.cancel();
    const result = await comparison.result;

    expect(result.a.outcome).toBe("cancelled");
    expect(result.b.outcome).toBe("cancelled");
    expect(createRunner).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it("should prevent sequential B allocation when A's result observer cancels the comparison", async () => {
    const createRunner = vi.fn(async () => ({ run: async () => makeExecutionResult(), close() {} }));
    const runtime = createQuickjsRuntime(makeRuntimeDependencies({ createRunner }));
    const manifest = makeExecutionManifest();
    const comparison = runtime.createComparison({ a: manifest, b: manifest }, { execution: "sequential" });
    void comparison.sides.a.result.then(() => comparison.cancel());
    comparison.start();
    const result = await comparison.result;

    expect(result.b.outcome).toBe("cancelled");
    expect(createRunner).toHaveBeenCalledOnce();
    await runtime.dispose();
  });

  it("should withhold runtime disposal until active comparison children stop", async () => {
    const running = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    const runtime = createQuickjsRuntime(
      makeRuntimeDependencies({
        createRunner: async () => ({
          async run(_manifest, options) {
            if (!options?.signal) {
              throw new Error("Missing comparison execution signal");
            }

            signals.push(options.signal);
            if (signals.length === 2) {
              running.resolve();
            }
            await stopped.promise;

            return { status: "cancelled", error: { phase: "run", message: "Cancelled" }, workerTerminated: true };
          },
          close() {},
        }),
      }),
    );
    const manifest = makeExecutionManifest();
    const comparison = runtime.createComparison({ a: manifest, b: manifest });
    comparison.start();
    await running.promise;
    const disposed = vi.fn();
    const disposal = runtime.dispose().then(disposed);

    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(disposed).not.toHaveBeenCalled();
    stopped.resolve();
    await disposal;

    expect((await comparison.result).a.outcome).toBe("cancelled");
    expect(disposed).toHaveBeenCalledOnce();
  });

  it("should preserve the timeout code from an interrupted guest report", async () => {
    const error = { phase: "run", code: "run_timeout", message: "QuickJS interrupted the run" } as const;
    const runtime = createQuickjsRuntime(
      makeRuntimeDependencies({
        createRunner: async () => ({
          async run(_manifest, options) {
            options?.onMessage?.({
              kind: "report",
              outcome: "failed",
              value: { type: "undefined" },
              error: { ...error, name: "Error" },
            });

            return { status: "error", error, workerTerminated: true };
          },
          close: vi.fn(),
        }),
      }),
    );
    const handle = runtime.createRun(makeExecutionManifest());
    handle.start();
    const result = await handle.result;

    expect(result.outcome).toBe("failed");
    expect(result.error?.code).toBe("run_timeout");
    await runtime.dispose();
  });

  it("should cancel queued preparation immediately without waiting for the active load", async () => {
    const loading = Promise.withResolvers<void>();
    const loaded = Promise.withResolvers<void>();
    const createRunner = vi.fn(async () => {
      loading.resolve();
      await loaded.promise;

      return { run: async () => makeExecutionResult(), close: vi.fn() };
    });
    const runtime = createQuickjsRuntime(makeRuntimeDependencies({ createRunner }));
    const first = runtime.prepare(makeExecutionManifest());
    await loading.promise;
    const controller = new AbortController();
    const queued = runtime.prepare(makeExecutionManifest(), { signal: controller.signal });

    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(createRunner).toHaveBeenCalledOnce();

    loaded.resolve();
    await first;
    await runtime.dispose();
  });

  it("should preserve timeout classification and forced teardown evidence", async () => {
    const runtime = createQuickjsRuntime(
      makeRuntimeDependencies({
        createRunner: async () => ({
          run: async () => ({
            status: "error",
            error: { phase: "run", code: "run_timeout", message: "Run exceeded timeout" },
            workerTerminated: true,
          }),
          close: vi.fn(),
        }),
      }),
    );
    const handle = runtime.createRun(makeExecutionManifest());
    handle.start();
    const result = await handle.result;

    expect(result.outcome).toBe("failed");
    expect(result.error?.code).toBe("run_timeout");
    expect(result.cleanupErrors).toEqual([]);
    expect(result.cleanup.guest.mode).toBe("forced");
    expect(result.cleanup.database.mode).toBe("forced");
    await runtime.dispose();
  });

  it("should withhold on-demand completion until resource release finishes", async () => {
    const closing = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const runtime = createQuickjsRuntime(
      makeRuntimeDependencies({
        preparation: "on_demand",
        createRunner: async () => ({
          run: async () => makeExecutionResult(),
          close() {
            closing.resolve();
            return closed.promise;
          },
        }),
      }),
    );
    const published = vi.fn();
    const prepared = runtime.prepare(makeExecutionManifest()).then(published);
    await closing.promise;

    expect(published).not.toHaveBeenCalled();

    closed.resolve();
    await prepared;
    await runtime.dispose();

    expect(published).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot().state).toBe("disposed");
  });

  it("should reject queued work and disposal when resource release fails", async () => {
    const closing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failure = new Error("release failed");
    const runtime = createQuickjsRuntime(
      makeRuntimeDependencies({
        preparation: "on_demand",
        createRunner: async () => ({
          run: async () => makeExecutionResult(),
          close() {
            closing.resolve();
            return release.promise;
          },
        }),
      }),
    );
    const prepared = runtime.prepare(makeExecutionManifest());
    const rejection = (async () => {
      await expect(prepared).rejects.toBe(failure);
    })();
    await closing.promise;
    const queued = runtime.prepare(makeExecutionManifest());
    const queuedRejection = (async () => {
      await expect(queued).rejects.toBe(failure);
    })();

    release.reject(failure);
    await Promise.all([rejection, queuedRejection]);

    await expect(runtime.prepare(makeExecutionManifest())).rejects.toThrow("disposed");
    await expect(runtime.dispose()).rejects.toThrow("release failed");
  });

  it("should close assets that finish loading after disposal", async () => {
    const loading = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    const close = vi.fn();
    const runtime = createQuickjsRuntime(
      makeRuntimeDependencies({
        createRunner: async (_selection, signal) => {
          loading.resolve(signal);
          await release.promise;

          return { run: async () => makeExecutionResult(), close };
        },
      }),
    );
    const prepared = runtime.prepare(makeExecutionManifest());
    const rejection = (async () => {
      await expect(prepared).rejects.toMatchObject({ name: "AbortError" });
    })();
    const signal = await loading.promise;

    const disposed = runtime.dispose();
    expect(signal.aborted).toBe(true);
    release.resolve();
    await Promise.all([rejection, disposed]);

    expect(close).toHaveBeenCalledOnce();
  });

  it("should reuse the selected assets and release them before selecting a different dialect", async () => {
    const close = vi.fn();
    const createRunner = vi.fn(async () => ({ run: async () => makeExecutionResult(), close }));
    const runtime = createQuickjsRuntime(makeRuntimeDependencies({ createRunner }));
    const manifest = makeExecutionManifest();

    await runtime.prepare(manifest);
    await runtime.prepare(manifest);
    expect(createRunner).toHaveBeenCalledTimes(1);
    await runtime.prepare({ ...manifest, target: { dialect: "sqlite" } });

    expect(createRunner).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(createRunner.mock.invocationCallOrder[1]);
    await runtime.dispose();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("should propagate disposal to an active execution and wait for it to stop", async () => {
    const running = Promise.withResolvers<AbortSignal>();
    const stopped = Promise.withResolvers<void>();
    const close = vi.fn();
    const runtime = createQuickjsRuntime(
      makeRuntimeDependencies({
        createRunner: async () => ({
          async run(_manifest, options) {
            if (!options?.signal) {
              throw new Error("Missing execution signal");
            }

            running.resolve(options.signal);
            await stopped.promise;

            return { status: "cancelled", error: { phase: "run", message: "Cancelled" }, workerTerminated: true };
          },
          close,
        }),
      }),
    );
    const handle = runtime.createRun(makeExecutionManifest());
    handle.start();
    const signal = await running.promise;

    const disposed = runtime.dispose();
    expect(signal.aborted).toBe(true);
    expect(close).not.toHaveBeenCalled();
    stopped.resolve();
    await disposed;

    expect((await handle.result).outcome).toBe("cancelled");
    expect(close).toHaveBeenCalledOnce();
  });
});
