import type { SerializedError, SerializedValue } from "./serialization.ts";

/** The phases of a run, in the order Drizzle Run runs them. */
export const EXECUTION_PHASES = [
  "validate",
  "resolve",
  "load_artifacts",
  "compile",
  "evaluate_schema",
  "generate_bootstrap",
  "open_database",
  "apply_bootstrap",
  "initialize_context",
  "seed",
  "run",
  "inspect",
  // Query plans, only when the run submission turns them on: fills the run's tables and plans its queries.
  "plan",
  "cleanup",
] as const;

/** One phase of a run. */
export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];

/** Where a phase stands. */
export type PhaseStatus = "pending" | "running" | "succeeded" | "skipped" | "failed" | "cancelled";

/** One phase's status and timing. */
export interface PhaseResult {
  phase: ExecutionPhase;
  status: PhaseStatus;
  startedAt?: string;
  durationMs?: number;
}

/** The code of the diagnostic that locates a failed run's error in the project's source. */
export const RUN_ERROR_DIAGNOSTIC_CODE = "run-error";

/** A compiler or runtime message about the project, with its location when known. */
export interface Diagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  code?: string;
  source?: string;
  line?: number;
  column?: number;
}

/** What sent a SQL statement. */
export type SqlEventOrigin = "kit" | "adapter" | "drizzle" | "managed_client";

/** One SQL statement a run generated or executed. */
export interface SqlEvent {
  sequence: number;
  phase: "bootstrap" | "seed" | "run" | "inspect";
  origin: SqlEventOrigin;
  kind: "generated" | "executed";
  sql: string;
  parameters: readonly SerializedValue[];
  /** SQLite bindings retain their names rather than depending on object enumeration order. */
  namedParameters?: Readonly<Record<string, SerializedValue>>;
  /** The project file and 1-based line of the query that ran it, when one could be told apart. */
  source?: string;
  line?: number;
  durationMs?: number;
  /**
   * Rows the statement returned or changed, when the driver reports it: node-postgres `rowCount`, libSQL
   * `rows.length` for reads and `rowsAffected` for writes. Absent for DDL, transaction control and SQLite batches.
   */
  rowCount?: number;
  outcome: "succeeded" | "failed";
  error?: SerializedError;
}

/** One console call from user code. */
export interface LogEvent {
  sequence: number;
  phase: "schema" | "seed" | "run";
  level: "debug" | "info" | "log" | "warn" | "error";
  values: readonly SerializedValue[];
  /** The project file and 1-based line of the console call. */
  source?: string;
  line?: number;
}

/** One `$.display` call: its label and values. */
export interface DisplayResult {
  label: string;
  values: readonly SerializedValue[];
  /** The project file and 1-based line of the `$.display` call. */
  source?: string;
  line?: number;
}

/**
 * What a statement inside a transaction did
 *
 * Transaction control comes from the SQL text. A write is what Postgres tagged as one (`INSERT`, `UPDATE`, ...) or
 * what the text shows as one (a `with` query that updates, Postgres reports under `SELECT`); SQLite reports no tags,
 * so its roles come from the text only.
 */
export type TransactionStatementRole =
  | "begin"
  | "commit"
  | "rollback"
  | "savepoint"
  | "release"
  | "rollback_to"
  | "read"
  | "write";

/** One statement a transaction sent itself: the `sequence` of its `SqlEvent` and what it did. */
export interface TransactionStatement {
  sequence: number;
  role: TransactionStatementRole;
}

/**
 * One `transaction(...)` call of a run
 *
 * A transaction with a `parent` is a savepoint inside it. Statements belong to the innermost transaction open when
 * they ran, so a savepoint's statements are not repeated in its parent.
 */
export interface RunTransaction {
  /** 1-based, in the order the transactions began. */
  id: number;
  /** The enclosing transaction's id. */
  parent?: number;
  phase: "seed" | "run";
  /** The project file and 1-based line of the `transaction(...)` call. */
  source?: string;
  line?: number;
  /** How it ended; a savepoint that `committed` was released. */
  outcome: "committed" | "rolled_back";
  /** Why it rolled back: `tx.rollback()` was called, or another error left its callback. */
  reason?: "rollback_call" | "error";
  /** The error that rolled it back, with where it was thrown when the runtime could tell. */
  error?: { name: string; message: string; source?: string; line?: number };
  /** Whether its writes are in the database after the run: `kept` when it and every transaction around it committed. */
  writes: "kept" | "undone";
  statements: readonly TransactionStatement[];
  durationMs: number;
}

/** The Postgres database after a run, by schema. */
export interface PostgresDatabaseDescription {
  dialect: "postgresql";
  schemas: readonly PostgresSchemaDescription[];
}

/** One Postgres schema and what it holds. */
export interface PostgresSchemaDescription {
  name: string;
  tables: readonly DatabaseTableDescription[];
  views: readonly DatabaseViewDescription[];
  enums: readonly { name: string; values: readonly string[] }[];
  sequences: readonly { name: string }[];
}

/** The SQLite database after a run. */
export interface SqliteDatabaseDescription {
  dialect: "sqlite";
  tables: readonly SqliteTableDescription[];
  views: readonly DatabaseViewDescription[];
}

/** One table with its columns, keys, indexes, and checks. */
export interface DatabaseTableDescription {
  name: string;
  columns: readonly DatabaseColumnDescription[];
  primaryKey: readonly string[];
  foreignKeys: readonly DatabaseForeignKeyDescription[];
  indexes: readonly DatabaseIndexDescription[];
  checks: readonly string[];
}

/** A SQLite table, with its `CREATE` statement when known. */
export interface SqliteTableDescription extends DatabaseTableDescription {
  sql?: string;
  autoIncrement: boolean;
}

/** One table column. */
export interface DatabaseColumnDescription {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue?: string;
  generatedExpression?: string;
}

/** One foreign key. */
export interface DatabaseForeignKeyDescription {
  columns: readonly string[];
  referencedTable: string;
  referencedColumns: readonly string[];
}

/** One index. */
export interface DatabaseIndexDescription {
  name: string;
  columns: readonly string[];
  unique: boolean;
}

/** One view. */
export interface DatabaseViewDescription {
  name: string;
  definition?: string;
}

/** The database after a run, in either dialect. */
export type DatabaseDescription = PostgresDatabaseDescription | SqliteDatabaseDescription;

/** A run error with the phase it happened in. */
export interface ExecutionError extends SerializedError {
  phase: ExecutionPhase;
}

/** Duration of each phase and the whole run, in milliseconds. */
export type PhaseTimings = Partial<Record<ExecutionPhase | "total", number>>;
