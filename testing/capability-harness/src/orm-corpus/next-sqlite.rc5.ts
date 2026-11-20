import * as orm from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { usedTablesOf } from "drizzle-orm/used-tables";

import * as schema from "./next-sqlite.schema.ts";
import type { OrmCase } from "./types.ts";

const { users } = schema;

export const extraCases: OrmCase<LibSQLDatabase<typeof schema.relations>>[] = [
  {
    id: "query-cache-opt-in",
    run: async (db) => {
      return {
        usedTables: usedTablesOf(users),
        defaults: await db.select({ id: users.id }).from(users).orderBy(users.id).$withCache(),
        configured: await db
          .select({ name: users.name })
          .from(users)
          .where(orm.eq(users.id, 1))
          .$withCache({ tag: "corpus-user", config: { ex: 60 }, autoInvalidate: false }),
        disabled: await db.select({ id: users.id }).from(users).orderBy(users.id).limit(1).$withCache(false),
      };
    },
  },
];
