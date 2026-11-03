// Run with node:test, separately from the Vitest unit suite.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { CreateRunOptions, Runtime } from "@drizzle-run/core/contracts";
import type { RunManifest } from "@drizzle-run/core/manifest";
import { createNodeRuntime } from "@drizzle-run/runtime/node";

import { makeSdkManifest } from "./sdk-corpus.ts";

async function execute({
  runtime,
  manifest,
  options = {},
}: {
  runtime: Runtime;
  manifest: RunManifest;
  options?: CreateRunOptions;
}) {
  const run = runtime.createRun(manifest, { signal: AbortSignal.timeout(90_000), ...options });
  run.start();
  return run.result;
}

await test("Node SDK records fresh entropy and replays explicit seeds", { timeout: 90_000 }, async () => {
  await using runtime = createNodeRuntime();
  const { randomSeed: _seed, ...manifest } = makeSdkManifest({
    dialect: "sqlite",
    query: "export default [Math.random(), $.random.uuid()];",
  });
  const first = await execute({ runtime, manifest });
  const second = await execute({ runtime, manifest });
  const replay = await execute({ runtime, manifest: { ...manifest, randomSeed: first.random.effectiveSeed } });

  assert.equal(first.outcome, "succeeded");
  assert.equal(second.outcome, "succeeded");
  assert.equal(replay.outcome, "succeeded");
  assert.equal(first.random.source, "generated");
  assert.equal(first.random.derivation, "crypto-u32-v1");
  assert.notEqual(first.random.effectiveSeed, second.random.effectiveSeed);
  assert.notDeepEqual(first.value, second.value);
  assert.deepEqual(first.value, replay.value);
  assert.equal(replay.random.source, "provided");

  const comparison = runtime.createComparison({
    a: { ...manifest, randomSeed: 42 },
    b: { ...manifest, randomSeed: 42 },
  });
  comparison.start();
  const result = await comparison.result;

  assert.deepEqual(result.a.value, result.b.value);
  assert.equal(result.a.random.effectiveSeed, 42);
  assert.equal(result.b.random.effectiveSeed, 42);
});

await test(
  "installed Node SDK executes both dialects, both release lines and fresh repeated runs",
  { timeout: 120_000 },
  async () => {
    await using runtime = createNodeRuntime();
    for (const dialect of ["postgresql", "sqlite"] as const) {
      for (const release of ["legacy", "next"] as const) {
        for (let repeat = 0; repeat < 2; repeat++) {
          const manifest = makeSdkManifest({ dialect, releaseLine: release });
          await runtime.prepare(manifest);
          const result = await execute({
            runtime,
            manifest,
            options: { queryPlans: { size: "seed", measureRealTime: false } },
          });
          assert.equal(result.outcome, "succeeded", JSON.stringify(result.error));
          assert.match(JSON.stringify(result.value), /Ada/);
          assert.ok(result.sql.some(({ sql }) => /create table/i.test(sql)));
          assert.ok(result.queryPlans && result.queryPlans.queries.length > 0);
          assert.deepEqual(result.cleanup, { guest: { mode: "graceful" }, database: { mode: "graceful" } });
        }
      }
    }
  },
);

await test(
  "Node compiler rejects filesystem and unapproved imports; errors keep source locations",
  { timeout: 60_000 },
  async () => {
    await using runtime = createNodeRuntime();
    for (const source of ['import "node:fs";', 'import "./missing.ts";', 'import "file:///etc/passwd";']) {
      const result = await execute({
        runtime,
        manifest: makeSdkManifest({ dialect: "sqlite", releaseLine: "next", query: source }),
      });
      assert.equal(result.outcome, "failed");
      assert.ok(result.diagnostics.length > 0);
    }
    const result = await execute({
      runtime,
      manifest: makeSdkManifest({
        dialect: "sqlite",
        releaseLine: "next",
        query: 'throw new Error("sdk-source-location");',
      }),
    });
    assert.ok(result.outcome === "failed");
    assert.match(result.error.message, /sdk-source-location/);
  },
);

await test(
  "startup and executing cancellation settle after cleanup and permit a fresh run",
  { timeout: 90_000 },
  async () => {
    await using runtime = createNodeRuntime();
    const startup = runtime.createRun(makeSdkManifest({ dialect: "postgresql" }));
    startup.start();
    await startup.cancel();
    assert.equal((await startup.result).outcome, "cancelled");
    for (const query of [
      "while (true) {}",
      'import { db } from "@drizzle-run/runtime/context"; import { sql } from "drizzle-orm"; await db.run(sql`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n`);',
    ]) {
      const run = runtime.createRun(makeSdkManifest({ dialect: "sqlite", releaseLine: "next", query }));
      run.subscribe((snapshot) => {
        if (snapshot.phase === "run" && snapshot.status === "active") {
          setTimeout(() => {
            void run.cancel();
          }, 100);
        }
      });
      run.start();
      assert.equal((await run.result).outcome, "cancelled");
      const next = await execute({ runtime, manifest: makeSdkManifest({ dialect: "sqlite" }) });
      assert.equal(next.outcome, "succeeded", JSON.stringify(next.error));
    }
  },
);

await test(
  "blocking SQLite planning preserves the successful run and abandons only its database",
  { timeout: 45_000 },
  async () => {
    await using runtime = createNodeRuntime();
    const result = await execute({
      runtime,
      manifest: makeSdkManifest({
        dialect: "sqlite",
        releaseLine: "next",
        query:
          'import { db } from "@drizzle-run/runtime/context"; import { sql } from "drizzle-orm"; export default await db.all(sql`select count(*) from users a, users b, users c`);',
      }),
      options: {
        queryPlans: { size: "10k", measureRealTime: true },
      },
    });
    assert.equal(result.outcome, "succeeded", JSON.stringify(result.error));
    assert.equal(result.cleanup.database.reason, "planning_abandoned");
    assert.equal(result.cleanup.database.mode, "forced");
  },
);

await test("parent deadline stops a stuck guest and permits the next run", { timeout: 45_000 }, async () => {
  await using runtime = createNodeRuntime();
  const result = await execute({
    runtime,
    manifest: makeSdkManifest({ dialect: "sqlite", releaseLine: "next", query: "while (true) {}" }),
  });
  assert.ok(result.outcome === "failed");
  assert.equal(result.error.code, "run_timeout");
  assert.equal((await execute({ runtime, manifest: makeSdkManifest({ dialect: "sqlite" }) })).outcome, "succeeded");
});
