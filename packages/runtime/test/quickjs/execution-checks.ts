import * as z from "zod/mini";

import type {
  ComparisonOptions,
  ComparisonResults,
  ComparisonSide,
  ExecutionResult,
  QuickjsManifest,
  QuickjsRunner,
  RunOptions,
} from "../../src/quickjs/contract.ts";
import { decodeResult } from "../../src/quickjs/contract.ts";
import { makeExecutionManifest } from "./execution-fixture.ts";

const FixtureValueSchema = z.object({
  rows: z.array(z.object({ id: z.number(), name: z.string() })),
  schemaEvaluations: z.number(),
  code: z.string(),
  parameter: z.number(),
  date: z.date(),
  big: z.bigint(),
  bytes: z.instanceof(Uint8Array),
  random: z.number(),
  helper: z.string(),
});

export interface AcceptanceReport {
  assertions: number;
  runs: { label: string; result: ExecutionResult }[];
}

export interface AcceptanceAdapter {
  createRunner: (options?: { mode?: "fresh" | "snapshot" }) => Promise<QuickjsRunner>;
  compare: (manifests: Record<ComparisonSide, unknown>, options?: ComparisonOptions) => Promise<ComparisonResults>;
}

/** Identical real execution assertions for Node and both browser engines. Throws on the first mismatch. */
export async function checkExecution({ createRunner, compare }: AcceptanceAdapter): Promise<AcceptanceReport> {
  const report: AcceptanceReport = { assertions: 0, runs: [] };
  const expectedSql = ['CREATE TABLE "users" (\n\t"id" integer PRIMARY KEY NOT NULL,\n\t"name" text NOT NULL\n);\n'];
  const expectedRows = [
    { id: 1, name: "Ada" },
    { id: 2, name: "Ada" },
    { id: 3, name: "Ada" },
    { id: 10, name: "Committed" },
  ];
  let runner: QuickjsRunner | undefined;
  let reference: string | undefined;

  function check(condition: unknown, message: string): asserts condition {
    report.assertions++;

    if (!condition) {
      throw new Error(message);
    }
  }

  function verify(result: ExecutionResult) {
    check(result.status === "success", `Execution failed: ${JSON.stringify(result.error)}`);
    check(result.workerTerminated, "Result published before worker termination");
    check(JSON.stringify(result.sql) === JSON.stringify(expectedSql), "Kit SQL differs from the concrete expected SQL");
    const value = FixtureValueSchema.parse(decodeResult(result.value));
    check(
      JSON.stringify(value.rows) === JSON.stringify(expectedRows),
      "Seed, commit, rollback, or row isolation failed",
    );
    check(value.schemaEvaluations === 1, "Schema evaluated more than once");
    check(value.code === "42703" && value.parameter === 42, "PostgreSQL error code or parameterized query failed");
    check(value.date.toISOString() === "2024-01-02T03:04:05.000Z", "Date type or value was lost");
    check(
      value.big === 9_007_199_254_740_993n && value.bytes[0] === 0 && value.bytes[1] === 255,
      "BigInt or bytes were lost",
    );

    if (reference) {
      check(
        JSON.stringify(result.value) === reference,
        "Seeded output differs across fresh/original/restored execution",
      );
    } else {
      reference = JSON.stringify(result.value);
    }
  }

  async function run({
    label,
    manifest = makeExecutionManifest(),
    options,
  }: {
    label: string;
    manifest?: QuickjsManifest;
    options?: RunOptions;
  }) {
    check(runner, "Acceptance runner is missing");
    const result = await runner.run(manifest, options);
    report.runs.push({ label, result });

    return result;
  }

  try {
    runner = await createRunner({ mode: "fresh" });
    const fresh = await run({ label: "fresh" });
    verify(fresh);
    check(fresh.retainedTemplateBytes === 0, "Fresh mode retained a snapshot");
    await runner.close();

    runner = await createRunner();
    const original = await run({ label: "original", options: { debug: true } });
    const restored = await run({ label: "restored" });
    verify(original);
    verify(restored);
    check(
      original.memory?.restored === false && original.memory.firstUsesOriginalVm === true,
      "First run did not use its original VM",
    );
    check(restored.memory?.restored === true, "Second run did not restore the dependency snapshot");
    check(
      Array.isArray(original.cleanupDiagnostics) && Array.isArray(restored.cleanupDiagnostics),
      "Cleanup evidence is missing outside debug mode",
    );

    for (const [label, source, expectedStatus] of [
      ["circular_result", "const value = {}; value.self = value; export default value;", "success"],
      ["unsupported_result", "export default { value: () => 1, invalid: NaN };", "success"],
      ["unhandled_rejection", "void Promise.reject(new Error('unhandled sentinel')); export default 1;", "error"],
      [
        "handled_rejection",
        "const promise = Promise.reject(new Error('handled sentinel')); await $.wait(0); await promise.catch(() => {}); export default 1;",
        "success",
      ],
      [
        "timer_error",
        "setTimeout(() => { throw new Error('timer sentinel'); }, 0); await $.wait(30); export default 1;",
        "error",
      ],
      [
        "expired_rejection",
        "void Promise.reject(new Error('expired sentinel')); await $.wait(2000); export default 1;",
        "error",
      ],
    ] as const) {
      const manifest = makeExecutionManifest();
      manifest.files["tasks/query.ts"] = source;
      const result = await run({ label, manifest });
      check(result.status === expectedStatus, `${label} produced ${result.status} instead of ${expectedStatus}`);
      check(result.workerTerminated, `${label} settled before termination`);
    }

    const resolved = makeExecutionManifest();
    resolved.files["models/index.mts"] = 'export { users } from "./tables";';
    resolved.files["models/check.js"] = 'export { value } from "./value.mjs";';
    resolved.files["models/value.mjs"] = "export const value = 42;";
    resolved.files["models/tables.ts"] +=
      '\nimport { value } from "./check"; if (value !== 42) throw new Error("JS module failed");';

    for (const path of ["tasks/seed.ts", "tasks/query.ts"]) {
      resolved.files[path] = resolved.files[path].replace("../models/tables.ts", "../models");
    }

    verify(await run({ label: "extension_and_directory_resolution", manifest: resolved }));

    const entropy: z.output<typeof FixtureValueSchema>[] = [];

    for (let index = 0; index < 2; index++) {
      const manifest = makeExecutionManifest();
      delete manifest.randomSeed;
      const result = await run({ label: `entropy_${index}`, manifest });
      check(result.status === "success", "Unseeded execution failed");
      entropy.push(FixtureValueSchema.parse(decodeResult(result.value)));
    }

    check(
      entropy[0].random !== entropy[1].random && entropy[0].helper !== entropy[1].helper,
      "Unseeded runs replay snapshot random state",
    );

    const failures = [
      {
        label: "invalid_typescript",
        path: "models/tables.ts",
        source: "export const broken: = ;",
        phase: "compile",
        located: true,
      },
      {
        label: "unapproved_import",
        path: "models/tables.ts",
        source: 'import "node:fs";',
        phase: "compile",
        located: true,
      },
      {
        label: "missing_import",
        path: "models/tables.ts",
        source: 'import "./absent";',
        phase: "compile",
        located: true,
      },
      {
        label: "missing_export",
        path: "models/tables.ts",
        source: 'import { absent } from "drizzle-orm/pg-core"; export const value = absent;',
        phase: "compile",
        located: true,
      },
      {
        label: "schema_failure",
        path: "models/tables.ts",
        source: 'export const users = {}; throw new Error("schema failed");',
        phase: "schema",
        located: true,
      },
      {
        label: "seed_failure",
        path: "tasks/seed.ts",
        source: 'import {db,schema} from "@drizzle-run/runtime/context"; await db.insert(schema.users).values({id:1});',
        phase: "seed",
        located: false,
      },
      {
        label: "located_runtime_error",
        path: "tasks/query.ts",
        source: '\nthrow new Error("located failure");',
        phase: "run",
        located: true,
      },
      {
        label: "database_error",
        path: "tasks/query.ts",
        source:
          'import {client} from "@drizzle-run/runtime/context"; await client.query("select missing_column from users");',
        phase: "run",
        located: false,
      },
    ] as const;

    for (const fixture of failures) {
      const manifest = makeExecutionManifest();
      manifest.files[fixture.path] = fixture.source;
      const result = await run({ label: fixture.label, manifest });
      check(
        result.status === "error" && result.error?.phase === fixture.phase && result.workerTerminated,
        `Wrong error phase or teardown: ${fixture.label}: ${JSON.stringify(result)}`,
      );

      if (fixture.located) {
        const diagnostic = result.error.diagnostics?.[0];
        check(
          diagnostic?.source === fixture.path &&
            diagnostic.line === (fixture.label === "located_runtime_error" ? 2 : 1) &&
            (diagnostic.column ?? 0) > 0,
          `Missing source location: ${fixture.label}: ${JSON.stringify(result.error)}`,
        );
      }
    }

    for (const phase of ["compile", "setup"] as const) {
      const controller = new AbortController();
      const result = await run({
        label: `cancel_${phase}`,
        options: {
          signal: controller.signal,
          onPhase: (current) => {
            if (current === phase) {
              controller.abort();
            }
          },
        },
      });
      check(
        result.status === "cancelled" && result.workerTerminated && result.error?.phase === phase,
        `Cancellation failed during ${phase}`,
      );
    }

    for (const [label, source] of [
      ["cancel_wait", "await $.wait(10000);"],
      ["cancel_cpu", "while (true) {}"],
    ]) {
      const manifest = makeExecutionManifest();
      manifest.files["tasks/query.ts"] = source;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        const result = await run({
          label,
          manifest,
          options: {
            signal: controller.signal,
            onPhase(phase) {
              if (phase === "run") {
                timer = setTimeout(() => controller.abort(), 30);
              }
            },
          },
        });
        check(result.status === "cancelled" && result.workerTerminated, `${label} did not terminate its worker`);
      } finally {
        clearTimeout(timer);
      }
    }

    const empty = makeExecutionManifest();
    delete empty.entrypoints.seed;
    empty.files["tasks/query.ts"] =
      'import {db,schema} from "@drizzle-run/runtime/context"; export default await db.select().from(schema.users);';
    const emptyResult = await run({ label: "fresh_unseeded_database", manifest: empty });
    check(
      emptyResult.status === "success" && JSON.stringify(decodeResult(emptyResult.value)) === "[]",
      "Rows leaked across executions",
    );
    verify(await run({ label: "recovery_after_failures" }));
    await runner.close();
    check((await run({ label: "closed_runner" })).error?.phase === "admission", "Closed runner admitted execution");
    runner = undefined;

    const slow = makeExecutionManifest();
    slow.files["tasks/query.ts"] = 'await $.wait(1500); export default "a";';
    const fast = makeExecutionManifest();
    fast.files["tasks/query.ts"] = 'export default "b";';
    const delivered: ComparisonSide[] = [];
    const parallel = await compare(
      { a: slow, b: fast },
      {
        onSide(side, result) {
          check(result.workerTerminated, `Comparison delivered ${side} before termination`);
          delivered.push(side);
        },
      },
    );
    check(
      parallel.a.status === "success" && parallel.b.status === "success" && delivered.join() === "b,a",
      "Parallel sides did not settle independently",
    );

    const failed = makeExecutionManifest();
    failed.files["tasks/query.ts"] = 'throw new Error("side failed");';
    const sequential = await compare({ a: failed, b: makeExecutionManifest() }, { mode: "sequential" });
    check(sequential.a.status === "error", "Failed side was not attributed");
    verify(sequential.b);

    const controller = new AbortController();
    const cancelled = await compare(
      { a: slow, b: fast },
      {
        mode: "sequential",
        signal: controller.signal,
        onPhase(side, phase) {
          if (side === "a" && phase === "run") {
            controller.abort();
          }
        },
      },
    );
    check(
      cancelled.a.status === "cancelled" &&
        cancelled.a.workerTerminated &&
        cancelled.b.status === "cancelled" &&
        cancelled.b.workerTerminated === undefined,
      "Sequential cancellation allocated B or settled before stopping A",
    );

    return report;
  } finally {
    await runner?.close();
  }
}
