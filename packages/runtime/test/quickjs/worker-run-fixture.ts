import type { Dialect } from "@drizzle-run/core/catalog";

import { parseRuntimeWorkerMessage, type RuntimeWorkerMessage } from "../../src/browser/protocol.ts";
import { createDatabaseEngine } from "../../src/database/database-engine.ts";
import type { ExecutionMode, QuickjsManifest } from "../../src/quickjs/contract.ts";
import { loadNodeAssets } from "../../src/quickjs/node-assets.ts";
import { selectGuest } from "../../src/quickjs/selection.ts";
import type { DependencyTemplate, ExecutionAssets } from "../../src/quickjs/worker-contract.ts";
import { executeWorkerRun } from "../../src/quickjs/worker-run.ts";

const assets = new Map<Dialect, Promise<ExecutionAssets>>();

/** Run the actual compiler, guest, and database inside the instrumented test process. */
export async function runWorkerFixture({
  manifest,
  mode = "fresh",
  template,
  closeFailure,
}: {
  manifest: QuickjsManifest;
  mode?: ExecutionMode;
  template?: DependencyTemplate;
  closeFailure?: Error;
}) {
  const dialect = manifest.target.dialect;
  let loaded = assets.get(dialect);

  if (!loaded) {
    loaded = loadNodeAssets({
      directory: new URL("../../dist/quickjs/", import.meta.url),
      selection: selectGuest(manifest),
    });
    assets.set(dialect, loaded);
  }

  const messages: RuntimeWorkerMessage[] = [];
  let captured: DependencyTemplate | undefined;
  let databaseClosed = false;
  const result = await executeWorkerRun({
    request: {
      manifest,
      assets: await loaded,
      mode,
      template,
      debug: false,
      queryPlans: { size: "seed", measureRealTime: false },
    },
    send(message) {
      if (message.type === "message") {
        messages.push(parseRuntimeWorkerMessage(message.message));
      } else if (message.type === "template") {
        captured = message.template;
      }
    },
    createDatabase(target) {
      const database = createDatabaseEngine(target);

      async function close() {
        await (await database).close();
        databaseClosed = true;

        if (closeFailure) {
          throw closeFailure;
        }
      }

      return {
        call: async (operation, value) => (await database).call(operation, value),
        close,
        terminate: close,
      };
    },
  });

  return { result, messages, captured, databaseClosed, assets: await loaded };
}

/** A real SQLite project with seed, transaction rollback, timers, logs, and display output. */
export function makeSqliteWorkerManifest(): QuickjsManifest {
  return {
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "sqlite" },
    dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
    randomSeed: 123,
    entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "run.ts" },
    files: {
      "schema.ts":
        'import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core"; export const notes = sqliteTable("notes", { id: integer().primaryKey(), body: text().notNull() });',
      "seed.ts":
        'import { db, schema } from "@drizzle-run/runtime/context"; await db.insert(schema.notes).values({ id: 1, body: "seeded" });',
      "run.ts": `import { db, schema } from "@drizzle-run/runtime/context";
        const cancelled = setTimeout(() => { throw new Error("Cleared timer ran"); }, 1000);
        clearTimeout(cancelled);
        await $.wait(1);
        try { await db.transaction(async tx => { await tx.insert(schema.notes).values({ id: 2, body: "rolled back" }); throw new Error("rollback"); }); } catch (cause) { if (cause.message !== "rollback") throw cause; }
        const rows = await db.select().from(schema.notes);
        console.log("rows", rows.length);
        $.display("Rows", rows);
        export default rows;`,
    },
  };
}
