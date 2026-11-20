import * as orm from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as pg from "drizzle-orm/pg-core";

import * as schema from "./next-postgresql.schema.ts";
import { runRolledBack } from "./run-cases.ts";
import type { OrmCase } from "./types.ts";

type Database = NodePgDatabase<typeof schema.relations>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export const extraCases: OrmCase<Database>[] = [
  {
    id: "postgres-procedure-call",
    run: async (db) =>
      runRolledBack(
        (body: (tx: Transaction) => Promise<unknown>) => db.transaction(body),
        async (tx) => {
          const rename = pg.procedure("corpus_rename_user", { name: "text" }, () => {});
          await tx.execute(orm.sql`create procedure corpus_rename_user(p_name text) language sql
            as $$ update corpus_users set name = p_name where id = 1 $$`);
          await tx.call(rename, { name: "Renamed" });

          return {
            procedure: pg.isPgProcedure(rename),
            unsupported: pg.isPgUnsupportedProcedure(rename),
            user: await tx.select({ name: schema.users.name }).from(schema.users).where(orm.eq(schema.users.id, 1)),
          };
        },
      ),
  },
];
