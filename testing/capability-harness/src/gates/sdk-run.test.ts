import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runProject, withCleanup } from "./sdk-run.ts";

void describe("SDK acceptance execution", () => {
  void it("should retain the public result after starting and settling cleanup", async () => {
    const calls: string[] = [];
    const result = { cleanupErrors: [], events: [] };
    const runtime = {
      createRun: () => ({
        start: () => calls.push("start"),
        result: Promise.resolve(result),
        cancel: async () => calls.push("cancel"),
      }),
    };

    assert.deepEqual(await runProject({ runtime, manifest: {} }), { report: result, events: [] });
    assert.deepEqual(calls, ["start", "cancel"]);
  });

  void it("should fail the gate and cancel execution when its deadline expires", async () => {
    let cancelled = false;
    const runtime = {
      createRun: () => ({
        start() {},
        result: new Promise<{ cleanupErrors: never[]; events: never[] }>(() => {}),
        cancel: async () => {
          cancelled = true;
        },
      }),
    };

    await assert.rejects(runProject({ runtime, manifest: {}, timeoutMs: 1 }), /Execution exceeded 1 ms/);
    assert.equal(cancelled, true);
  });

  void it("should reject cleanup failures rather than count a successful run", async () => {
    const runtime = {
      createRun: () => ({
        start() {},
        result: Promise.resolve({ cleanupErrors: [{ message: "close failed" }], events: [] }),
        cancel: async () => {},
      }),
    };

    await assert.rejects(runProject({ runtime, manifest: {} }), /Execution must release its resources/);
  });

  void it("should bound hanging cancellation and retain the execution timeout", async () => {
    const runtime = {
      createRun: () => ({
        start() {},
        result: new Promise<{ cleanupErrors: never[]; events: never[] }>(() => {}),
        cancel: () => new Promise<never>(() => {}),
      }),
    };

    await assert.rejects(runProject({ runtime, manifest: {}, timeoutMs: 1, cleanupTimeoutMs: 1 }), (cause: unknown) => {
      assert.ok(cause instanceof AggregateError);
      assert.match(cause.message, /Execution exceeded 1 ms/);
      assert.match(String(cause.errors[1]), /Cleanup exceeded 1 ms/);

      return true;
    });
  });

  void it("should retain the original failure when cancellation rejects", async () => {
    const executionError = new Error("execution failed");
    const cleanupError = new Error("cancel failed");
    const runtime = {
      createRun: () => ({
        start() {},
        result: Promise.reject<{ cleanupErrors: never[]; events: never[] }>(executionError),
        cancel: async () => {
          throw cleanupError;
        },
      }),
    };

    await assert.rejects(runProject({ runtime, manifest: {} }), (cause: unknown) => {
      assert.ok(cause instanceof AggregateError);
      assert.equal(cause.cause, executionError);
      assert.deepEqual(cause.errors, [executionError, cleanupError]);

      return true;
    });
  });

  void it("should fail a successful operation when disposal cannot settle", async () => {
    await assert.rejects(
      withCleanup({
        work: async () => "succeeded",
        cleanup: () => new Promise<never>(() => {}),
        cleanupTimeoutMs: 1,
      }),
      /Cleanup exceeded 1 ms/,
    );
  });

  void it("should run cleanup when work throws synchronously", async () => {
    const original = new Error("start failed");
    let cleaned = false;

    await assert.rejects(
      withCleanup({
        work: () => {
          throw original;
        },
        cleanup: async () => {
          cleaned = true;
        },
      }),
      (cause: unknown) => cause === original,
    );
    assert.equal(cleaned, true);
  });
});
