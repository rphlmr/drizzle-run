import { describe, expect, it, vi } from "vitest";

import { makeExecutionManifest } from "../../test/quickjs/execution-fixture.ts";
import {
  makeExecutionAssets,
  makeExecutionResult,
  makeExecutionWorker,
  makeTemplate,
} from "../../test/quickjs/runner-fixture.ts";
import { createRunner } from "./runner.ts";

describe("createRunner", () => {
  it("should withhold publication and admission until termination completes", async () => {
    const terminating = Promise.withResolvers<void>();
    const terminated = Promise.withResolvers<void>();
    const runner = createRunner({
      assets: makeExecutionAssets(),
      createWorker: () =>
        makeExecutionWorker({
          terminate: () => {
            terminating.resolve();
            return terminated.promise;
          },
        }),
    });
    const published = vi.fn();
    const execution = runner.run(makeExecutionManifest()).then(published);
    await terminating.promise;

    expect(published).not.toHaveBeenCalled();
    expect((await runner.run(makeExecutionManifest())).error?.phase).toBe("admission");
    expect(() => runner.close()).toThrow("active run");

    terminated.resolve();
    await execution;

    expect(published).toHaveBeenCalledWith(expect.objectContaining({ status: "success", workerTerminated: true }));
    runner.close();
  });

  it("should settle cleanup failure while retaining ownership and refusing admission", async () => {
    const attempted = Promise.withResolvers<void>();
    const terminate = vi.fn(() => {
      attempted.resolve();
      throw new Error("termination failed");
    });
    const createWorker = vi.fn(() => makeExecutionWorker({ terminate }));
    const runner = createRunner({ assets: makeExecutionAssets(), createWorker });
    const published = vi.fn();
    const execution = runner.run(makeExecutionManifest()).then(published);
    await attempted.promise;
    await Promise.resolve();

    expect((await runner.run(makeExecutionManifest())).error?.phase).toBe("admission");
    await execution;
    expect(published).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        error: expect.objectContaining({ code: "cleanup_failed", phase: "cleanup" }),
        cleanup: {
          guest: { mode: "forced", reason: "host_termination_failed" },
          database: { mode: "forced", reason: "host_termination_failed" },
        },
      }),
    );
    expect(published.mock.calls[0]?.[0].workerTerminated).toBeUndefined();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(() => runner.close()).toThrow("cleanup failed");
  });

  it("should settle cancellation when host cleanup rejects", async () => {
    const controller = new AbortController();
    const runner = createRunner({
      assets: makeExecutionAssets(),
      createWorker: () =>
        makeExecutionWorker({
          send(receive) {
            receive({ type: "phase", phase: "run" });
          },
          terminate: async () => {
            throw new Error("Host cleanup failed");
          },
        }),
    });

    const result = await runner.run(makeExecutionManifest(), {
      signal: controller.signal,
      onPhase: () => controller.abort(),
    });

    expect(result).toMatchObject({
      status: "error",
      error: { code: "cleanup_failed", message: "Host cleanup failed" },
    });
    expect(result.workerTerminated).toBeUndefined();
    expect((await runner.run(makeExecutionManifest())).error?.phase).toBe("admission");
  });

  it("should terminate on cancellation and release the snapshot on close", async () => {
    const template = makeTemplate();
    const controller = new AbortController();
    const terminate = vi.fn();
    const runner = createRunner({
      assets: makeExecutionAssets(),
      createWorker: () =>
        makeExecutionWorker({
          terminate,
          send(receive) {
            receive({ type: "template", template });
            receive({ type: "phase", phase: "run" });
          },
        }),
    });
    const result = await runner.run(makeExecutionManifest(), {
      signal: controller.signal,
      onPhase: () => controller.abort(),
    });

    expect(result).toMatchObject({ status: "cancelled", workerTerminated: true, error: { phase: "run" } });
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(template.memory.byteLength).toBe(1_024);

    runner.close();
    runner.close();

    expect(template.memory.byteLength).toBe(0);
    expect((await runner.run(makeExecutionManifest())).error?.phase).toBe("admission");
  });

  it("should terminate after send failure and admit a subsequent run", async () => {
    const terminate = vi.fn();
    let count = 0;
    const runner = createRunner({
      assets: makeExecutionAssets(),
      createWorker: () =>
        makeExecutionWorker({
          terminate,
          send(receive) {
            if (count++ === 0) {
              throw new Error("send failed");
            }

            receive({ type: "result", result: makeExecutionResult() });
          },
        }),
    });

    expect(await runner.run(makeExecutionManifest())).toMatchObject({ status: "error", workerTerminated: true });
    expect(await runner.run(makeExecutionManifest())).toMatchObject({ status: "success", workerTerminated: true });
    expect(terminate).toHaveBeenCalledTimes(2);
    runner.close();
  });

  it("should reject unsupported manifests without allocating a worker", async () => {
    const createWorker = vi.fn(() => makeExecutionWorker());
    const runner = createRunner({ assets: makeExecutionAssets(), createWorker });
    const manifest = makeExecutionManifest();

    expect(await runner.run({ ...manifest, target: { dialect: "sqlite" } })).toMatchObject({
      status: "error",
      error: { phase: "validation" },
    });
    expect(createWorker).not.toHaveBeenCalled();
    runner.close();
  });
});
