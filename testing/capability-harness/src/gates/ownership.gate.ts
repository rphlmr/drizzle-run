import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

import type { Runtime } from "../../../../packages/core/src/contracts/index.ts";
import { parseRunManifest } from "../../../../packages/core/src/manifest/index.ts";
import { createNodeRuntime } from "../../../../packages/runtime/dist/node/index.js";
import { waitWithin, withCleanup } from "./sdk-run.ts";

const schema =
  'import { integer, sqliteTable } from "drizzle-orm/sqlite-core"; export const rows = sqliteTable("ownership_rows", { id: integer().primaryKey() });';
const recovery =
  'import { db, schema } from "@drizzle-run/runtime/context"; export default { rows: (await db.select().from(schema.rows)).length };';

function createManifest({ run = recovery }: { run?: string } = {}) {
  return parseRunManifest({
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "sqlite" },
    dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
    files: { "schema.ts": schema, "run.ts": run },
    entrypoints: { schema: "schema.ts", run: "run.ts" },
  });
}

function listChildProcesses() {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" });
  return rows
    .trim()
    .split("\n")
    .map((row) => row.trim().split(/\s+/))
    .filter(([, parent, command]) => Number(parent) === process.pid && !/(?:^|\/)ps$/.test(command))
    .map(([pid]) => Number(pid));
}

async function listTemporaryDirectories() {
  return (await readdir(tmpdir())).filter((name) => name.startsWith("drizzle-run-quickjs-")).toSorted();
}

async function runRecovery(runtime: Runtime) {
  const handle = runtime.createRun(createManifest());
  handle.start();
  const result = await waitWithin({ work: () => handle.result, timeoutMs: 60_000, message: "Recovery did not settle" });
  assert.equal(result.outcome, "succeeded", JSON.stringify(result.error));
  assert.deepEqual(result.cleanupErrors, []);
  assert.deepEqual(result.value, { type: "object", value: { rows: { type: "primitive", value: 0 } } });
  assert.ok(result.database, "Recovery inspects its fresh database");
}

/** Cancel the production SDK at each execution boundary and check that its processes and temporary data are gone. */
export async function runOwnershipGate() {
  const baselineDirectories = await listTemporaryDirectories();
  const baselineChildren = new Set(listChildProcesses());
  const runtime = createNodeRuntime();
  const cancelled: string[] = [];

  await withCleanup({
    work: async () => {
      await runRecovery(runtime);

      for (const stage of ["idle", "compile", "run", "user_loop", "sql"]) {
        const run =
          stage === "user_loop"
            ? 'console.log("ownership-ready"); while (true) {}'
            : stage === "sql"
              ? 'import { db } from "@drizzle-run/runtime/context"; import { sql } from "drizzle-orm"; console.log("ownership-ready"); await db.all(sql.raw("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 1000000000) SELECT sum(x) FROM n"));'
              : recovery;
        const handle = runtime.createRun(createManifest({ run }));
        const reached = Promise.withResolvers<void>();
        const snapshotSubscription = handle.subscribe((snapshot) => {
          if (snapshot.phase === stage) {
            reached.resolve();
          }
        });
        const eventSubscription = handle.subscribeEvent((event) => {
          if (
            ["user_loop", "sql"].includes(stage) &&
            event.type === "log" &&
            JSON.stringify(event.payload.values).includes("ownership-ready")
          ) {
            reached.resolve();
          }
        });

        await withCleanup({
          work: async () => {
            if (stage !== "idle") {
              handle.start();
              await waitWithin({
                work: () =>
                  Promise.race([
                    reached.promise,
                    handle.result.then((result) => {
                      throw new Error(`Execution settled before ${stage}: ${JSON.stringify(result.error)}`);
                    }),
                  ]),
                timeoutMs: 60_000,
                message: `Execution did not reach ${stage}`,
              });
            }

            await waitWithin({
              work: () => handle.cancel(),
              timeoutMs: 10_000,
              message: `Cancellation did not settle during ${stage}`,
            });
            const result = await waitWithin({
              work: () => handle.result,
              timeoutMs: 10_000,
              message: `Cancelled execution did not settle during ${stage}`,
            });
            assert.equal(result.outcome, "cancelled", `Cancellation during ${stage}`);
            assert.deepEqual(result.cleanupErrors, []);
            cancelled.push(stage);
            await runRecovery(runtime);
          },
          cleanup: async () => {
            snapshotSubscription.unsubscribe();
            eventSubscription.unsubscribe();
            await handle.cancel();
          },
        });
      }
    },
    cleanup: () => runtime.dispose(),
  });

  assert.deepEqual(
    await listTemporaryDirectories(),
    baselineDirectories,
    "Disposed runs leave no temporary database/snapshot directories",
  );
  assert.deepEqual(
    listChildProcesses().filter((pid) => !baselineChildren.has(pid)),
    [],
    "Disposed runs leave no child processes",
  );

  return { cancelled, recovery: "fresh database after every cancellation" };
}

console.log("runtime ownership gate passed", JSON.stringify(await runOwnershipGate()));
