import assert from "node:assert/strict";

import type { Executor, RunHandle, RunResult, RunSnapshot } from "@drizzle-run/core/contracts";
import { defineRunManifest } from "@drizzle-run/core/manifest";
import { createComparisonController, createRunController } from "@drizzle-run/orchestration";

const manifest = defineRunManifest({
  kind: "drizzle-run",
  manifestVersion: 1,
  target: { dialect: "sqlite" },
  dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
  files: { "schema.ts": "export {};" },
  entrypoints: { schema: "schema.ts" },
});

const evidence = {
  version: 1,
  target: manifest.target,
  tuple: { id: "fixture", target: manifest.target, ormVersion: "0.45.4", kitVersion: "0.31.11" },
  random: {
    effectiveSeed: 1,
    source: "provided",
    derivation: "run-manifest-sha256-u32-v1",
    generator: "mulberry32-v1",
  },
  phases: [],
  diagnostics: [],
  sql: [],
  logs: [],
  value: { type: "undefined" },
  displays: [],
  events: [],
  cleanupErrors: [],
  cleanup: { guest: { mode: "graceful" }, database: { mode: "graceful" } },
  timings: {},
} satisfies Omit<RunResult, "ok" | "outcome">;

/** A controlled executor with no browser or database implementation. */
function createControlledExecutor() {
  const completion = Promise.withResolvers<RunResult>();
  const cleanup = Promise.withResolvers<void>();
  const snapshots = new Set<(snapshot: RunSnapshot) => void>();
  let cancelled = false;
  const handle: RunHandle = {
    result: completion.promise,
    start() {
      for (const listener of snapshots) {
        listener({ state: "running", status: "active", sequence: 1, elapsedMs: 0 });
      }
    },
    async cancel() {
      cancelled = true;
      await cleanup.promise;
      completion.resolve({ ...evidence, ok: false, outcome: "cancelled" });
    },
    subscribe(listener) {
      snapshots.add(listener);

      return { unsubscribe: () => snapshots.delete(listener) };
    },
    subscribeEvent() {
      return { unsubscribe() {} };
    },
  };
  const executor: Executor = { createRun: () => handle };

  return { executor, completion, cleanup, wasCancelled: () => cancelled };
}

assert.equal("window" in globalThis, false);
assert.equal("document" in globalThis, false);
assert.equal("Worker" in globalThis, false);

for (const outcome of ["succeeded", "failed", "cancelled"] as const) {
  const controlled = createControlledExecutor();
  const runs = createRunController({ runtime: controlled.executor });
  const outcomes: string[] = [];
  runs.onSettled((settled) => outcomes.push(settled.outcome));

  try {
    const pending = runs.submit({ manifest, revision: 1, debug: false }, { requester: "node-consumer" });

    if (outcome === "cancelled") {
      void runs.cancel();
      assert.equal(controlled.wasCancelled(), true);
      assert.equal(runs.getState().status === "running", true);
      assert.deepEqual(outcomes, []);
      controlled.cleanup.resolve();
    } else if (outcome === "failed") {
      controlled.completion.resolve({
        ...evidence,
        ok: false,
        outcome,
        error: { name: "Error", message: "Controlled execution failure", phase: "run" },
      });
    } else {
      controlled.completion.resolve({ ...evidence, ok: true, outcome });
    }

    await pending;
    assert.deepEqual(outcomes, [outcome]);
  } finally {
    await runs.dispose();
  }
}

const sides: number[] = [];
const pair = createComparisonController({
  execution: "sequential",
  async runSide({ side }) {
    sides.push(side);

    return "succeeded";
  },
});

try {
  await pair.submit({ requester: "node-consumer" });
  assert.deepEqual(sides, [0, 1]);
} finally {
  await pair.dispose();
}

console.log("Node orchestration consumer passed: success, failure, cancellation after cleanup, sequential pair.");
