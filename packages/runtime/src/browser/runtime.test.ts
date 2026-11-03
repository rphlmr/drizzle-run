import type { RuntimeCapabilities } from "@drizzle-run/core/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeExecutionManifest } from "../../test/quickjs/execution-fixture.ts";
import { makeExecutionResult } from "../../test/quickjs/runner-fixture.ts";
import { encodeDatabaseValue } from "../database/database-codec.ts";
import type { QuickjsRunner } from "../quickjs/contract.ts";
import type * as Capabilities from "./capabilities.ts";

const controls = vi.hoisted(() => ({
  createRunner: vi.fn(),
  capabilities: { status: "available", reasons: [] } as RuntimeCapabilities,
}));
vi.mock("../quickjs/browser.ts", () => ({ createBrowserRunner: controls.createRunner }));
vi.mock("./capabilities.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof Capabilities>()),
  checkRuntimeCapabilities: async () => controls.capabilities,
}));

import { createBrowserRuntime } from "./index.ts";

describe("createBrowserRuntime", () => {
  it("should generate and record fresh seeds while preserving explicit seeds", async () => {
    controls.createRunner.mockImplementation(async () => ({ run: async () => makeExecutionResult(), close() {} }));
    const entropy = vi.spyOn(crypto, "getRandomValues");
    entropy.mockReturnValueOnce(new Uint32Array([123])).mockReturnValueOnce(new Uint32Array([456]));
    const runtime = createBrowserRuntime({ assetBaseUrl: "https://example.test/runtime/" });
    const { randomSeed: _seed, ...unseeded } = makeExecutionManifest();

    try {
      const first = runtime.createRun(unseeded);
      const second = runtime.createRun(unseeded);
      const explicit = runtime.createRun({ ...unseeded, randomSeed: 789 });
      first.start();
      second.start();
      explicit.start();
      const results = await Promise.all([first.result, second.result, explicit.result]);

      expect(results.map((result) => result.random.effectiveSeed)).toEqual([123, 456, 789]);
      expect(entropy).toHaveBeenCalledTimes(2);
    } finally {
      entropy.mockRestore();
      await runtime[Symbol.asyncDispose]();
    }
  });

  beforeEach(() => {
    controls.createRunner.mockReset();
    controls.capabilities = { status: "available", reasons: [] };
  });

  it("should create lazily and cancel an unstarted run without allocating a runner", async () => {
    const runtime = createBrowserRuntime({ assetBaseUrl: "https://example.test/runtime/" });
    const run = runtime.createRun(makeExecutionManifest());
    await run.cancel();

    expect((await run.result).outcome).toBe("cancelled");
    expect(controls.createRunner).not.toHaveBeenCalled();
    await runtime[Symbol.asyncDispose]();
    expect(runtime.getSnapshot().state).toBe("disposed");
  });

  it("should retain ordered events, mapped call sites, transactions and requested query plans", async () => {
    const close = vi.fn();
    const runner: QuickjsRunner = {
      close,
      async run(_manifest, options) {
        options?.onMessage?.({
          kind: "compiled",
          sourceMap: JSON.stringify({
            version: 3,
            sources: ["drizzle-run-project:tasks/query.ts"],
            names: [],
            mappings: "AAEA",
          }),
        });
        options?.onMessage?.({ kind: "phase", phase: "run", status: "running" });
        options?.onMessage?.({
          kind: "event",
          type: "log",
          payload: {
            sequence: 1,
            phase: "run",
            level: "log",
            values: [{ type: "primitive", value: "hello" }],
            frames: "1:1",
          },
        });
        options?.onMessage?.({
          kind: "event",
          type: "sql",
          payload: {
            sequence: 1,
            phase: "run",
            origin: "drizzle",
            kind: "executed",
            sql: "select 1",
            parameters: [],
            outcome: "succeeded",
            rowCount: 1,
            commandTags: ["SELECT"],
          },
        });
        options?.onMessage?.({
          kind: "event",
          type: "display",
          payload: { label: "result", values: [{ type: "primitive", value: 1 }] },
        });
        options?.onMessage?.({ kind: "phase", phase: "run", status: "succeeded", durationMs: 3 });
        options?.onMessage?.({
          kind: "report",
          outcome: "succeeded",
          value: { type: "primitive", value: 1 },
          database: encodeDatabaseValue({ dialect: "postgresql", schemas: [] }),
          transactions: [{ id: 1, phase: "run", outcome: "committed", statements: [1], durationMs: 1 }],
          ...(options.queryPlans
            ? {
                queryPlans: {
                  settings: options.queryPlans,
                  dialect: "postgresql",
                  fills: [],
                  queries: [],
                  skipped: [],
                  durationMs: 1,
                },
              }
            : {}),
        });

        return { ...makeExecutionResult(), cleanup: { guest: { mode: "graceful" }, database: { mode: "graceful" } } };
      },
    };
    controls.createRunner.mockResolvedValue(runner);
    const runtime = createBrowserRuntime({ assetBaseUrl: "https://example.test/runtime/" });
    const run = runtime.createRun(makeExecutionManifest(), { queryPlans: { size: "100k", measureRealTime: true } });
    run.start();
    const result = await run.result;

    expect(result.outcome).toBe("succeeded");
    expect(result.events.map((event) => event.type)).toEqual(["log", "sql", "display"]);
    expect(result.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(result.logs[0]).toMatchObject({ source: "tasks/query.ts", line: 3 });
    expect(result.sql[0]).toMatchObject({ rowCount: 1 });
    expect(result.displays[0]?.label).toBe("result");
    expect(result.transactions).toHaveLength(1);
    expect(result.queryPlans?.settings).toEqual({ size: "100k", measureRealTime: true });
    expect(result.cleanupErrors).toEqual([]);
    await runtime.dispose();
    expect(close).toHaveBeenCalledOnce();
  });

  it("should retry capability checks without allocating resources while unavailable", async () => {
    controls.capabilities = {
      status: "browser_unsupported",
      reasons: [{ code: "no_dedicated_worker", message: "Worker is unavailable" }],
    };
    const runtime = createBrowserRuntime({ assetBaseUrl: "https://example.test/runtime/" });

    await expect(runtime.prepare(makeExecutionManifest())).rejects.toThrow("Worker is unavailable");
    expect(controls.createRunner).not.toHaveBeenCalled();
    controls.capabilities = { status: "available", reasons: [] };
    controls.createRunner.mockResolvedValue({ run: async () => makeExecutionResult(), close: vi.fn() });
    await runtime.prepare(makeExecutionManifest());
    expect(runtime.getSnapshot().state).toBe("ready");
    await runtime.dispose();
  });
});
