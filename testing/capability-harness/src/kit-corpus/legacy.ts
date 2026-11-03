import * as pg from "drizzle-orm/pg-core";

import { createPostgresCases } from "./cases.ts";
import type { PgReleaseApi } from "./types.ts";

export { sqliteCases } from "./cases.ts";

/** Legacy pg-core has no `bytea` export, so a custom type declares it; RLS is enabled on the built table. */
const legacyPgApi = {
  bytea: () => pg.customType<{ data: Uint8Array }>({ dataType: () => "bytea" })(),
  rlsTable: (name, columns) => pg.pgTable(name, columns).enableRLS(),
} satisfies PgReleaseApi;

/** The PostgreSQL scenarios on ORM 0.45.4 and Kit 0.31.11. */
export const postgresCases = createPostgresCases(legacyPgApi);
