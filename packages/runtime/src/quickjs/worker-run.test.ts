import { afterAll, describe, expect, it, vi } from "vitest";

import { makeExecutionManifest } from "../../test/quickjs/execution-fixture.ts";
import { makeSqliteWorkerManifest, runWorkerFixture } from "../../test/quickjs/worker-run-fixture.ts";
import * as planner from "../query-plans/planner.ts";
import { stopCompiler } from "./compiler.ts";
import { decodeResult } from "./contract.ts";
import { createExecutionVm } from "./vm.ts";

vi.mock("esbuild-wasm", () => vi.importActual("esbuild-wasm/lib/browser.js"));
vi.stubGlobal("self", globalThis);

afterAll(async () => {
  await stopCompiler();
  vi.unstubAllGlobals();
});

describe("executeWorkerRun real execution", () => {
  it("should preserve a failed query's database cause", async () => {
    const manifest = makeSqliteWorkerManifest();
    manifest.files["run.ts"] =
      'import { db } from "@drizzle-run/runtime/context"; import { sql } from "drizzle-orm"; await db.run(sql`select * from accounts`);';

    const { messages } = await runWorkerFixture({ manifest });
    const report = messages.findLast((message) => message.kind === "report");

    expect(report).toMatchObject({
      kind: "report",
      outcome: "failed",
      error: {
        message: expect.stringContaining("Failed query"),
        cause: { message: expect.stringContaining("no such table: accounts") },
      },
    });
  }, 30_000);

  it.each(["x", "é"])(
    "should give actionable guidance for oversized %s results measured in bytes",
    async (character) => {
      const manifest = makeSqliteWorkerManifest();
      manifest.files["run.ts"] =
        `export default ${JSON.stringify(character)}.repeat(${character === "x" ? 3 : 1.5} * 1024 * 1024);`;

      const { result, messages } = await runWorkerFixture({ manifest });

      expect(result).toMatchObject({
        status: "error",
        error: { message: expect.stringContaining("Log or return less of it") },
      });
      expect(messages).toContainEqual(expect.objectContaining({ kind: "report", outcome: "failed" }));
    },
    30_000,
  );

  it("should pass evaluated schema property mappings to query planning", async () => {
    const planning = vi.spyOn(planner, "planQueries");
    const manifest = makeSqliteWorkerManifest();
    manifest.files["schema.ts"] =
      'import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core"; export const notes = sqliteTable("notes", { id: integer().primaryKey(), body: text("stored_body").notNull() });';

    try {
      const execution = await runWorkerFixture({ manifest });

      expect(execution.result.status).toBe("success");
      expect(planning).toHaveBeenCalledWith(
        expect.objectContaining({
          keys: [{ name: "notes", columns: { id: "id", stored_body: "body" } }],
        }),
      );
    } finally {
      planning.mockRestore();
    }
  });

  it("should initialize independent random streams after capturing a clean dependency snapshot", async () => {
    const manifest = makeSqliteWorkerManifest();
    manifest.files["run.ts"] = `
      if (globalThis.projectMarker) throw new Error("Project globals leaked");
      globalThis.projectMarker = true;
      export default [Math.random(), $.random.integer(), Math.random(), $.random.integer()];
    `;
    const fresh = await runWorkerFixture({ manifest });
    const original = await runWorkerFixture({ manifest, mode: "snapshot" });
    const template = original.captured;

    if (!template) {
      throw new Error("The original run did not capture its dependency snapshot");
    }

    const context = await createExecutionVm({
      wasm: await WebAssembly.compile(new Uint8Array(original.assets.wasmBytes)),
      extensions: await Promise.all(
        original.assets.extensionBytes.map(async ({ name, bytes }) => ({
          name,
          wasm: await WebAssembly.compile(new Uint8Array(bytes)),
        })),
      ),
      modules: new Map(),
      startedAtMs: performance.now(),
      template,
    });

    try {
      const globals = context.vm.evalCode(
        '[typeof $, typeof __runManifest, typeof __observation, typeof __displays, typeof projectMarker].join(",")',
      );

      try {
        expect(globals.toString()).toBe("undefined,undefined,undefined,undefined,undefined");
      } finally {
        globals.dispose();
      }
    } finally {
      context.vm.dispose();
    }

    const restored = await runWorkerFixture({ manifest, mode: "snapshot", template });

    for (const execution of [fresh, original, restored]) {
      expect(execution.result.status).toBe("success");
      expect(execution.result.value && decodeResult(execution.result.value)).toEqual([
        0.7872516233474016, 787251, 0.1785435655619949, 178543,
      ]);
    }
  }, 30_000);

  it("should emit rejected-import diagnostics and clean up without allocating a database", async () => {
    const manifest = makeSqliteWorkerManifest();
    manifest.files["run.ts"] = 'import "node:fs"; export default 1;';
    const { result, messages, databaseClosed } = await runWorkerFixture({ manifest });

    expect(result).toMatchObject({ status: "error", error: { phase: "compile", code: "compile_error" } });
    expect(result.error?.diagnostics?.length).toBeGreaterThan(0);
    expect(messages).toContainEqual(expect.objectContaining({ kind: "event", type: "diagnostic" }));
    expect(messages).toContainEqual(expect.objectContaining({ kind: "report", outcome: "failed" }));
    expect(result.timings).toHaveProperty("cleanupMs");
    expect(databaseClosed).toBe(false);
  }, 30_000);

  it.each([
    { label: "thrown error", source: 'throw new Error("guest sentinel");', message: "guest sentinel" },
    { label: "thrown string", source: 'throw "guest string";', message: "guest string" },
    {
      label: "unhandled string rejection",
      source: 'Promise.reject("rejection string"); export default 1;',
      message: "rejection string",
    },
    {
      label: "unhandled rejection",
      source: 'Promise.reject(new Error("unhandled sentinel")); export default 1;',
      message: "unhandled sentinel",
    },
    {
      label: "timer error",
      source: 'await new Promise(() => setTimeout(() => { throw new Error("timer sentinel"); }, 0));',
      message: "timer sentinel",
    },
  ])(
    "should report a guest $label and release its database",
    async ({ source, message }) => {
      const manifest = makeSqliteWorkerManifest();
      manifest.files["run.ts"] = source;
      const { result, messages, databaseClosed } = await runWorkerFixture({ manifest });

      expect(result).toMatchObject({
        status: "error",
        error: { phase: "run", message },
      });
      expect(databaseClosed).toBe(true);
      expect(result.timings).toHaveProperty("cleanupMs");
      expect(messages).toContainEqual(expect.objectContaining({ kind: "report", outcome: "failed" }));
      expect(messages).not.toContainEqual(
        expect.objectContaining({ kind: "phase", phase: "inspect", status: "running" }),
      );
    },
    30_000,
  );

  it("should preserve the execution outcome and report a database close failure", async () => {
    const { result, messages, databaseClosed } = await runWorkerFixture({
      manifest: makeSqliteWorkerManifest(),
      closeFailure: new Error("close sentinel"),
    });

    expect(result.status).toBe("success");
    expect(databaseClosed).toBe(true);
    expect(result.cleanupDiagnostics).toEqual(["Database: close sentinel"]);
    expect(result.cleanup?.database).toEqual({ mode: "forced", reason: "database_close_failed" });
    expect(messages).toContainEqual(expect.objectContaining({ kind: "report", outcome: "succeeded" }));
  }, 30_000);

  it("should execute a schema-only manifest without requiring seed or query entrypoints", async () => {
    const manifest = makeSqliteWorkerManifest();
    manifest.entrypoints = { schema: "schema.ts" };
    const { result, databaseClosed } = await runWorkerFixture({ manifest });

    expect(result).toMatchObject({ status: "success", value: { type: "undefined" } });
    expect(databaseClosed).toBe(true);
  }, 30_000);

  it("should execute the PostgreSQL seed and transaction fixture and close the database", async () => {
    const { result, messages, databaseClosed } = await runWorkerFixture({ manifest: makeExecutionManifest() });

    expect(result.status).toBe("success");
    expect(result.value && decodeResult(result.value)).toMatchObject({
      code: "42703",
      parameter: 42,
      schemaEvaluations: 1,
    });
    expect(databaseClosed).toBe(true);
    expect(messages).toContainEqual(expect.objectContaining({ kind: "report", outcome: "succeeded" }));
    expect(result.cleanupDiagnostics).toEqual([]);
  }, 30_000);

  it("should report a PostgreSQL bootstrap failure and close its rolled-back database", async () => {
    const manifest = makeExecutionManifest();
    manifest.entrypoints = { schema: "models/tables.ts" };
    manifest.files["models/tables.ts"] = `
      import { pgTable, integer } from "drizzle-orm/pg-core";
      import { sql } from "drizzle-orm";
      export const users = pgTable("users", { id: integer().default(sql\`missing_bootstrap_default()\`) });
    `;
    const { result, messages, databaseClosed } = await runWorkerFixture({ manifest });

    expect(result).toMatchObject({ status: "error", error: { phase: "database", code: "42883" } });
    expect(databaseClosed).toBe(true);
    expect(messages).toContainEqual(
      expect.objectContaining({
        kind: "report",
        outcome: "failed",
        error: expect.objectContaining({
          phase: "apply_bootstrap",
          message: expect.stringContaining("missing_bootstrap_default"),
        }),
      }),
    );
  }, 30_000);

  it("should restore SQLite dependencies into an isolated database and preserve guest output", async () => {
    const manifest = makeSqliteWorkerManifest();
    const original = await runWorkerFixture({ manifest, mode: "snapshot" });
    expect(original.result.status).toBe("success");
    expect(original.captured).toBeDefined();
    const restored = await runWorkerFixture({ manifest, mode: "snapshot", template: original.captured });

    expect(restored.result.status).toBe("success");
    expect(restored.result.value && decodeResult(restored.result.value)).toEqual([{ id: 1, body: "seeded" }]);
    expect(restored.result.value).toEqual(original.result.value);
    expect(restored.result.memory?.restored).toBe(true);
    expect(restored.databaseClosed).toBe(true);
    expect(restored.result.displays).toHaveLength(1);
    expect(restored.messages).toContainEqual(expect.objectContaining({ kind: "event", type: "log" }));
  }, 30_000);
});
