import type * as pg from "drizzle-orm/pg-core";

/** One schema scenario of the Kit parity corpus, built fresh for each oracle run. */
export interface SchemaCase {
  /** Stable across release corpora, so coverage cannot silently diverge. */
  id: string;
  /** Paths/anchors under the pinned documentation commit recorded in README.md. */
  docs: readonly string[];
  empty?: boolean;
  schema(): Record<string, unknown>;
}

// pg-core names its column builder type differently per release, so read it from the columns `pgTable` accepts. The
// last `pgTable` overload takes a columns callback; its return type is the same columns map.
type PgTableColumnsParameter = Parameters<typeof pg.pgTable>[1];
type PgColumnsMap = PgTableColumnsParameter extends (...args: never[]) => infer TColumns
  ? TColumns
  : PgTableColumnsParameter;

/** A PostgreSQL column builder of the drizzle-orm release the corpus is checked against. */
export type PgColumn = PgColumnsMap[string];

/** The PostgreSQL schema APIs whose spelling differs between ORM releases; each release's corpus entry supplies them. */
export interface PgReleaseApi {
  /** A fresh `bytea` column. */
  bytea(): PgColumn;
  /** A table with row-level security enabled and no policies. */
  rlsTable(name: string, columns: Record<string, PgColumn>): unknown;
}
