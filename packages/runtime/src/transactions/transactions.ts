import type { RunTransaction, TransactionStatementRole } from "@drizzle-run/core/contracts";

/**
 * A transaction as the guest reports it
 *
 * Bundle frames stand in for the file and line, which the host resolves, and statements are listed by their
 * `SqlEvent.sequence` only.
 */
export interface WireTransaction {
  id: number;
  parent?: number;
  phase: "seed" | "run";
  frames?: string;
  outcome: "committed" | "rolled_back";
  reason?: "rollback_call" | "error";
  error?: { name: string; message: string; frames?: string };
  statements: readonly number[];
  durationMs: number;
}

/** Where bundle frames point in the project, or nothing when they point outside it. */
export type FrameLocator = (frames: string) => { source: string; line: number } | undefined;

const controlStatements: readonly [RegExp, TransactionStatementRole][] = [
  [/^(?:begin|start\s+transaction)\b/, "begin"],
  [/^(?:commit|end)\b/, "commit"],
  [/^rollback\s+to\b/, "rollback_to"],
  [/^rollback\b/, "rollback"],
  [/^savepoint\b/, "savepoint"],
  [/^release\b/, "release"],
];

const writeStart = /^(?:insert|update|delete|replace|merge|upsert|create|alter|drop|truncate)\b/;

/** A data-modifying statement inside a `with` query, such as `with moved as (update ...)`. */
const writeInsideWith = /\b(?:insert\s+into|update\s+\S+\s+set|delete\s+from)\b/;

/** Postgres command tags (first word) of statements that change the database. */
const writeCommandTags = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "TRUNCATE",
  "CREATE",
  "ALTER",
  "DROP",
  "REFRESH",
]);

/**
 * Classify a statement
 *
 * Transaction control (`begin`, `savepoint sp1`, `rollback to savepoint sp1`, `commit`) comes from the start of the
 * SQL text, since Postgres tags `rollback` and `rollback to` alike. A statement is a write when Postgres tagged any
 * part of the query as one (`commandTags`), which catches what the text hides, such as a leading comment or several
 * statements in one query. The text can still make it a write: Postgres reports a `with` query that updates and
 * `create table ... as select` under the outer `SELECT`. SQLite sends no tags, so its roles come from the text
 * alone: a write starts with a data or schema keyword, or is a `with` query holding an insert, update or delete.
 * Anything else reads.
 */
export function classifyStatement(sql: string, commandTags: readonly string[] = []): TransactionStatementRole {
  const text = sql.trim().toLowerCase();
  const control = controlStatements.find(([pattern]) => pattern.test(text));

  if (control !== undefined) {
    return control[1];
  }

  if (
    commandTags.some((tag) => writeCommandTags.has(tag)) ||
    writeStart.test(text) ||
    (text.startsWith("with") && writeInsideWith.test(text))
  ) {
    return "write";
  }

  return "read";
}

/**
 * Turn the guest's transactions into the run's
 *
 * Resolves each call site and error site, reads each statement's role from `roles` (keyed by SQL sequence; a
 * statement whose event was not seen reads), and marks a transaction kept when it and every transaction around it
 * committed. A transaction whose parent is missing or comes later is dropped with its savepoints, since its place in
 * the run is unknown.
 */
export function toRunTransactions({
  transactions,
  roles,
  locate,
}: {
  transactions: readonly WireTransaction[];
  roles: ReadonlyMap<number, TransactionStatementRole>;
  locate: FrameLocator;
}): RunTransaction[] {
  const kept = new Map<number, boolean>();
  const result: RunTransaction[] = [];

  for (const transaction of transactions) {
    const parentKept = transaction.parent === undefined ? true : kept.get(transaction.parent);

    if (parentKept === undefined || kept.has(transaction.id)) {
      continue;
    }

    const isKept = parentKept && transaction.outcome === "committed";
    kept.set(transaction.id, isKept);

    const site = transaction.frames === undefined ? undefined : locate(transaction.frames);
    const error = transaction.error;
    const errorSite = error?.frames === undefined ? undefined : locate(error.frames);

    result.push({
      id: transaction.id,
      ...(transaction.parent === undefined ? {} : { parent: transaction.parent }),
      phase: transaction.phase,
      ...(site === undefined ? {} : { source: site.source, line: site.line }),
      outcome: transaction.outcome,
      ...(transaction.reason === undefined ? {} : { reason: transaction.reason }),
      ...(error === undefined
        ? {}
        : {
            error: {
              name: error.name,
              message: error.message,
              ...(errorSite === undefined ? {} : { source: errorSite.source, line: errorSite.line }),
            },
          }),
      writes: isKept ? "kept" : "undone",
      statements: transaction.statements.map((sequence) => ({ sequence, role: roles.get(sequence) ?? "read" })),
      durationMs: transaction.durationMs,
    });
  }

  return result;
}
