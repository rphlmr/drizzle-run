import type { QuickjsManifest } from "../../src/quickjs/contract.ts";

/** Custom paths exercise shared ESM identity across schema, seed, and run. */
export function makeExecutionManifest(): QuickjsManifest {
  return {
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "postgresql" },
    dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
    randomSeed: 123,
    seedGeneratorVersion: "2",
    entrypoints: { schema: "models/tables.ts", seed: "tasks/seed.ts", run: "tasks/query.ts" },
    files: {
      "models/tables.ts": `
        import { pgTable, integer, text } from "drizzle-orm/pg-core";
        if (globalThis.schemaEvaluations) throw new Error("Schema evaluated twice or leaked");
        globalThis.schemaEvaluations = 1;
        export const users = pgTable("users", { id: integer().primaryKey(), name: text().notNull() });
      `,
      "tasks/seed.ts": `
        import { seed } from "drizzle-seed";
        import { db, schema } from "@drizzle-run/runtime/context";
        import { users } from "../models/tables.ts";
        if (schema.users !== users) throw new Error("Schema identity lost");
        await seed(db, { users }, { count: 3, seed: 123 }).refine(f => ({ users: { columns: { name: f.valuesFromArray({ values: ["Ada"] }) } } }));
      `,
      "tasks/query.ts": `
        import { db, schema, client } from "@drizzle-run/runtime/context";
        import { users } from "../models/tables.ts";
        import { is, Table, sql } from "drizzle-orm";
        import { createInsertSchema } from "drizzle-zod";
        if (!is(users, Table) || schema.users !== users || globalThis.schemaEvaluations !== 1) throw new Error("ORM identity lost");
        const validator = createInsertSchema(users);
        if (!validator.safeParse({ id: 4, name: "Ada" }).success || validator.safeParse({ id: "bad", name: null }).success) throw new Error("Validator failed");
        await db.transaction(async tx => { await tx.insert(users).values({ id: 10, name: "Committed" }); });
        try { await db.transaction(async tx => { await tx.insert(users).values({ id: 11, name: "Rolled back" }); throw new Error("rollback"); }); } catch (e) { if (e.message !== "rollback") throw e; }
        let code;
        try { await client.query("select missing_column from users"); } catch (e) { code = e.code; }
        const parameter = await client.query("select $1::integer as n", [42]);
        const typed = await client.query("select '2024-01-02T03:04:05Z'::timestamptz as date, decode('00ff', 'hex') as bytes, '9007199254740993'::int8 as big");
        export default { rows: await db.select().from(users).orderBy(users.id), code, parameter: parameter.rows[0].n, date: typed.rows[0].date, bytes: typed.rows[0].bytes, big: BigInt(typed.rows[0].big), random: Math.random(), helper: $.random.uuid(), schemaEvaluations: globalThis.schemaEvaluations };
      `,
    },
  };
}
