import { listGuestImages } from "@drizzle-run/core/registry";

import { decodeDatabaseDescription, type RuntimeWorkerMessage } from "../../src/browser/protocol.ts";
import { decodeResult, QuickjsManifestSchema, type QuickjsRunner } from "../../src/quickjs/contract.ts";
import type { GuestSelection } from "../../src/quickjs/selection.ts";

/** Every published image must execute against each supported database, including restored dependency state. */
export async function checkGuestMatrix(createRunner: (selection: GuestSelection) => Promise<QuickjsRunner>) {
  const reports = [];

  for (const image of listGuestImages()) {
    for (const dialect of ["postgresql", "sqlite"] as const) {
      const selection = { imageId: image.id, dialect };
      const runner = await createRunner(selection);
      const manifest = QuickjsManifestSchema.parse({
        kind: "drizzle-run",
        manifestVersion: 1,
        target: { dialect },
        dependencies: { "drizzle-orm": image.ormVersion, "drizzle-kit": image.kitVersion },
        guestFlavor: image.guestFlavor,
        randomSeed: 123,
        entrypoints: { schema: "schema.ts", run: "run.ts" },
        files: {
          "schema.ts": `import { ${dialect === "postgresql" ? "pgTable" : "sqliteTable"} as table, integer } from "drizzle-orm/${dialect === "postgresql" ? "pg-core" : "sqlite-core"}";
            export const users = table("users", { id: integer().primaryKey() });`,
          "run.ts": `import { db, schema } from "@drizzle-run/runtime/context";
            await db.transaction(async tx => { await tx.insert(schema.users).values({ id: 1 }); });
            try { await db.transaction(async tx => { await tx.insert(schema.users).values({ id: 2 }); throw new Error("rollback"); }); } catch (cause) { if (cause.message !== "rollback") throw cause; }
            export default await db.select().from(schema.users);`,
        },
      });

      if (image.guestFlavor === "effect") {
        const clientImport = dialect === "postgresql" ? "@effect/sql-pg/PgClient" : "@effect/sql-libsql/LibsqlClient";
        const driverImport = dialect === "postgresql" ? "drizzle-orm/effect-postgres" : "drizzle-orm/effect-libsql";
        const layer =
          dialect === "postgresql"
            ? "Client.layerFrom(Client.makeClient(postgresConnection))"
            : "Client.layer({ liveClient: db.$client })";
        manifest.files["run.ts"] =
          manifest.files["run.ts"].replace(
            "export default await db.select().from(schema.users);",
            `
          const program = Effect.gen(function* () {
            const effectDb = yield* Driver.makeWithDefaults();
            return yield* effectDb.select().from(schema.users);
          });
          export default await Effect.runPromise(program.pipe(Effect.provide(${layer})));`,
          ) +
          `\nimport * as Effect from "effect/Effect"; import * as Client from "${clientImport}"; import * as Driver from "${driverImport}"; import { postgresConnection } from "@drizzle-run/runtime/context";`;
      }

      try {
        for (const restored of [false, true]) {
          const messages: RuntimeWorkerMessage[] = [];
          const result = await runner.run(manifest, {
            timeoutMs: 30_000,
            debug: true,
            queryPlans: { size: "seed", measureRealTime: false },
            onMessage: (message) => messages.push(message),
          });

          if (result.status !== "success") {
            throw new Error(`${image.id}/${dialect} (${restored ? "restored" : "fresh"}): ${JSON.stringify(result)}`);
          }

          if (
            JSON.stringify(decodeResult(result.value)) !== '[{"id":1}]' ||
            result.memory?.restored !== restored ||
            !result.workerTerminated
          ) {
            throw new Error(
              `${image.id}/${dialect} returned incorrect rows or lifecycle evidence: ${JSON.stringify(result)}`,
            );
          }
          const report = messages.find((message) => message.kind === "report");
          const statements = messages.filter((message) => message.kind === "event" && message.type === "sql");

          if (
            !report ||
            report.outcome !== "succeeded" ||
            report.transactions?.length !== 2 ||
            report.transactions[0].outcome !== "committed" ||
            report.transactions[1].outcome !== "rolled_back" ||
            !report.queryPlans?.queries.length ||
            statements.length < 5
          ) {
            throw new Error(
              `${image.id}/${dialect} lost transaction, SQL, or planning evidence: ${JSON.stringify(report)}`,
            );
          }

          decodeDatabaseDescription(report.database);
        }

        reports.push(selection);
      } finally {
        await runner.close();
      }
    }
  }

  return reports;
}
