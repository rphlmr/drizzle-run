import type { Dialect } from "../releases/dialects.ts";
import type { SerializedError, SerializedValue } from "./serialization.ts";

/** The table size a run's query plans assume. `seed` plans the run's own data as it is. */
export type QueryPlanSize = "seed" | "10k" | "100k" | "1m";

/** Every query plan size, smallest first. */
export const QUERY_PLAN_SIZES: readonly QueryPlanSize[] = ["seed", "10k", "100k", "1m"];

/** The Query plans flag of a run submission. Absent means the run is not planned. */
export interface QueryPlansSettings {
  size: QueryPlanSize;
  /**
   * Postgres only: run `EXPLAIN ANALYZE` on the filled tables at the chosen size, writes rolled back.
   * SQLite always times each query, so it ignores this.
   */
  measureRealTime: boolean;
}

/** How many rows each table held when the run's queries were planned at one size. */
export interface QueryPlanFill {
  size: QueryPlanSize;
  tables: readonly { name: string; schema?: string; rows: number }[];
  /** Time to generate the rows and refresh statistics; 0 at `seed`. */
  durationMs: number;
}

/** `EXPLAIN` output from Postgres for one query at one size, exactly as Postgres returned it. */
export interface PostgresRawPlan {
  database: "postgresql";
  size: QueryPlanSize;
  /** `EXPLAIN (FORMAT JSON)` text. */
  json: string;
  /** `EXPLAIN` text, one line per row. */
  text: string;
  /** `EXPLAIN (ANALYZE, FORMAT JSON)` and its text form, with Measure real time at the chosen size. */
  analyze?: { json: string; text: string } | { error: SerializedError };
}

/** One `EXPLAIN QUERY PLAN` row, untouched. */
export interface SqliteQueryPlanRow {
  id: number;
  parent: number;
  notused: number;
  detail: string;
}

/** Time measured by Drizzle Run inside the database, the query's rows discarded. */
export interface QueryPlanTiming {
  samples: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
}

/** `EXPLAIN QUERY PLAN` rows from SQLite for one query at one size, and the time it took there. */
export interface SqliteRawPlan {
  database: "sqlite";
  size: QueryPlanSize;
  rows: readonly SqliteQueryPlanRow[];
  timing: QueryPlanTiming | { error: SerializedError };
}

/** Database output for one query at one size. */
export type RawQueryPlan = PostgresRawPlan | SqliteRawPlan;

/** Why Drizzle Run tried an index: what it read in the plan. */
export type IndexTryTrigger =
  /** A full scan filtered on a column that has no index in the schema. */
  | "filtered_scan"
  /** A join on a foreign key column that has no index (SQLite builds an automatic index). */
  | "foreign_key_join"
  /** An `order by ... limit` that sorts the whole table. */
  | "sorted_limit";

/** An index the database confirmed: it used it and the query got at least ten times cheaper. */
export interface ConfirmedIndex {
  trigger: IndexTryTrigger;
  table: string;
  schema?: string;
  /** Database column names, in index order. */
  columns: readonly string[];
  name: string;
  /** The line to add to the table's extra config, such as `index("posts_author_idx").on(t.authorId)`. */
  drizzle: string;
  /** Postgres total cost, or SQLite median time in milliseconds, without and with the index. */
  measure: { unit: "cost" | "ms"; before: number; after: number };
  before: RawQueryPlan;
  after: RawQueryPlan;
}

/** Drizzle Run's reading of a plan, kept apart from the database's output. */
export interface QueryPlanReading {
  /** One plain sentence, such as "Full scan of posts, reads 1M rows to return 10". */
  summary: string;
  /** Stays fast when it reads a fixed number of rows; grows with each table it scans. */
  verdict: { kind: "stays_fast" } | { kind: "grows"; tables: readonly string[] };
  indexes: readonly ConfirmedIndex[];
}

/** One distinct statement from the run phase, planned at each size. */
export interface PlannedQuery {
  /** The `SqlEvent.sequence` of every run-phase event that sent this statement with these parameters. */
  sequences: readonly number[];
  sql: string;
  parameters: readonly SerializedValue[];
  namedParameters?: Readonly<Record<string, SerializedValue>>;
  /** Database output per size, smallest first; the last one is the chosen size. */
  raw: readonly RawQueryPlan[];
  /** Absent when the database could not plan the query; `error` says why. */
  reading?: QueryPlanReading;
  error?: SerializedError;
}

/** The query plans of a run: fills, planned queries, and skipped statements. */
export interface QueryPlansReport {
  settings: QueryPlansSettings;
  dialect: Dialect;
  /** Fills in planning order: `seed`, then each larger size planned. */
  fills: readonly QueryPlanFill[];
  queries: readonly PlannedQuery[];
  /** Run-phase statements that were not planned, and why. */
  skipped: readonly { sequences: readonly number[]; reason: string }[];
  durationMs: number;
  /** Set when planning stopped early; plans made before it stay. */
  error?: SerializedError;
}
