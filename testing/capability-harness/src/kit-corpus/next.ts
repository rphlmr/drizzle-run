import * as pg from "drizzle-orm/pg-core";

import { createPostgresCases } from "./cases.ts";
import type { PgReleaseApi } from "./types.ts";

export { sqliteCases } from "./cases.ts";

/** RC5 pg-core exports `bytea` and declares an RLS table with `pgTable.withRLS()`. */
const nextPgApi = {
  bytea: () => pg.bytea(),
  rlsTable: (name, columns) => pg.pgTable.withRLS(name, columns),
} satisfies PgReleaseApi;

/** The PostgreSQL scenarios on ORM and Kit 1.0.0-rc.5. */
export const postgresCases = createPostgresCases(nextPgApi);
