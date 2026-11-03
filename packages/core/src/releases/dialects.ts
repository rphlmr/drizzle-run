import * as z from "zod/mini";

/** What Drizzle Run knows about one database dialect. */
export interface DialectDescriptor {
  /** The database's name as the UI writes it, such as "PostgreSQL". */
  label: string;
  /** The name running text uses, such as "Postgres". */
  shortName: string;
  /** The catalog id of the database target, which names the adapter it runs on. */
  targetId: string;
  /** The Effect SQL client the `effect` guest flavor adds for it. */
  effectSqlClient: string;
  /** The orm.drizzle.team docs path prefix of its pages: "" or "sqlite/". */
  docsPathPrefix: string;
  /** The `schema.ts` a new project starts with. */
  starterSchema: string;
  queryPlans: {
    /** Whether its plan steps carry cost and row estimates. */
    estimatesCost: boolean;
    /** Whether the planner times every query, so Measure real time cannot be turned off. */
    alwaysTimesQueries: boolean;
  };
}

/**
 * Supported database dialects
 *
 * One entry per dialect. Code that differs by dialect reads its entry instead of comparing the dialect to a
 * literal, so a new dialect is a compile error wherever it needs a value.
 */
export const DIALECTS = {
  postgresql: {
    label: "PostgreSQL",
    shortName: "Postgres",
    targetId: "postgresql-pglite",
    effectSqlClient: "@effect/sql-pg",
    docsPathPrefix: "",
    starterSchema:
      'import { pgTable, integer, text } from "drizzle-orm/pg-core";\n\nexport const users = pgTable("users", {\n  id: integer("id").primaryKey(),\n  name: text("name").notNull(),\n});\n',
    queryPlans: { estimatesCost: true, alwaysTimesQueries: false },
  },
  sqlite: {
    label: "SQLite",
    shortName: "SQLite",
    targetId: "sqlite-wasm",
    effectSqlClient: "@effect/sql-libsql",
    docsPathPrefix: "sqlite/",
    starterSchema:
      'import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";\n\nexport const users = sqliteTable("users", {\n  id: integer("id").primaryKey(),\n  name: text("name").notNull(),\n});\n',
    queryPlans: { estimatesCost: false, alwaysTimesQueries: true },
  },
} as const satisfies Record<string, DialectDescriptor>;

/** A supported database dialect, such as "postgresql". */
export type Dialect = keyof typeof DIALECTS;

function isDialectKey(key: string): key is Dialect {
  return Object.hasOwn(DIALECTS, key);
}

/** Every supported dialect, in catalog order. */
export const DIALECT_IDS: readonly Dialect[] = Object.freeze(Object.keys(DIALECTS).filter(isDialectKey));

/** A supported dialect id. */
export const DialectSchema = z.enum(DIALECT_IDS, {
  error: `Expected ${DIALECT_IDS.map((dialect) => `"${dialect}"`).join(" or ")}.`,
});
