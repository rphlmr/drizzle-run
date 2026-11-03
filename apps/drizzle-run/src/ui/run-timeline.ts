import type {
  Diagnostic,
  ExecutionError,
  LogEvent,
  RunResult,
  RunTransaction,
  SerializedError,
  SerializedValue,
  SqlEvent,
  TransactionStatementRole,
} from "@drizzle-run/core/contracts";

import { getRunProblems } from "./output-tab";
import { countKeptWrites, getTransactionChildren, type TransactionChildren } from "./transactions";

/** An output view that filters the run's timeline. */
export type TimelineFilter = "story" | "results" | "logs" | "problems";

/** The Logs tab's filters: console lines and SQL together, or one of them. */
export const LOG_FILTERS = ["all", "console", "sql"] as const;

/** One of the Logs tab's filters. */
export type LogFilter = (typeof LOG_FILTERS)[number];

/** A problem in the timeline: a diagnostic, the run error, or a cleanup failure. */
export type TimelineProblem =
  /** The run settled with an error and no result. */
  | { kind: "thrown"; message: string }
  | {
      kind: "error";
      phase: ExecutionError["phase"];
      message: string;
      location?: Diagnostic;
      /** What the database said, when a failed statement threw the error, such as `relation "x" does not exist`. */
      query?: string;
    }
  | { kind: "diagnostic"; diagnostic: Diagnostic }
  | { kind: "cleanup"; error: SerializedError };

/** One entry of a run's timeline, in the order the runtime sent it. */
export type TimelineEntry = { key: string } & (
  | { kind: "sql"; event: SqlEvent }
  | { kind: "console"; event: LogEvent }
  | { kind: "result"; label: string | undefined; values: readonly SerializedValue[]; source?: string; line?: number }
  | { kind: "problem"; problem: TimelineProblem }
);

type SqlEntry = Extract<TimelineEntry, { kind: "sql" }>;

/**
 * SQL the runtime ran around the user's code, folded per phase: schema setup and inspection, and in Story the seed too.
 */
export interface SetupEntry {
  key: string;
  kind: "setup";
  phase: Exclude<SqlEvent["phase"], "run">;
  entries: readonly SqlEntry[];
  executed: number;
  durationMs: number | undefined;
}

/**
 * One transaction in Story: its card holds the rows that ran while it was open, savepoints nested as their own
 * groups.
 */
export interface TransactionGroup {
  key: string;
  kind: "transaction";
  transaction: RunTransaction;
  rows: readonly TimelineRow[];
  /** What each of its own statements did, by `SqlEvent.sequence`. */
  roles: ReadonlyMap<number, TransactionStatementRole>;
  /** Writes in the database after the run: its own and its released savepoints', when it committed. */
  keptWrites: number;
  /** The run failed inside it: its rollback was the last thing the run did. */
  stopped: boolean;
}

/** What threw inside a transaction and rolled it back, drawn just before its rollback. */
export interface RollbackCause {
  key: string;
  kind: "rollback_cause";
  error: NonNullable<RunTransaction["error"]>;
}

/**
 * Story's card for SQL the run sent outside a transaction from one call site, such as a final select, with the
 * result it fed when that result shows in Results.
 */
export interface QueryGroup {
  key: string;
  kind: "query";
  entries: readonly SqlEntry[];
  source: string | undefined;
  line: number | undefined;
  /** The label of the result these statements fed, such as "Balances". */
  display?: string;
}

/**
 * A row the output shows: an entry, a folded run of setup SQL, or in Story a transaction, what rolled it back, and a
 * query's card.
 */
export type TimelineRow = TimelineEntry | SetupEntry | TransactionGroup | RollbackCause | QueryGroup;

/** The parts of a run result the timeline reads. */
export type TimelineInput = Pick<
  RunResult,
  "events" | "value" | "displays" | "diagnostics" | "error" | "cleanupErrors"
>;

/** What Story reads beside the timeline to draw transactions. */
export type StoryInput = Pick<RunResult, "transactions" | "outcome" | "error">;

/** How many rows each tab and Logs filter chip counts; Logs counts its console lines and SQL together. */
export type TimelineCounts = Record<Exclude<TimelineFilter, "story"> | Exclude<LogFilter, "all">, number>;

function isSameDiagnostic(left: Diagnostic, right: Diagnostic | undefined) {
  return (
    right !== undefined &&
    left.severity === right.severity &&
    left.message === right.message &&
    left.source === right.source &&
    left.line === right.line &&
    left.column === right.column
  );
}

/**
 * The database's message for a run error a failed statement threw
 *
 * Drizzle wraps the driver's error ("Failed query: ..."), so the statement's error is found in the run error's cause
 * chain. An error thrown after a statement failed and was caught is not the statement's.
 */
function findFailedQuery(result: TimelineInput): SqlEvent | undefined {
  const messages = new Set<string>();

  for (let error: SerializedError | undefined = result.error; error !== undefined; error = error.cause) {
    messages.add(error.message);
  }

  const failed = result.events.findLast(
    (event) =>
      event.type === "sql" &&
      event.payload.outcome === "failed" &&
      event.payload.error !== undefined &&
      messages.has(event.payload.error.message),
  );

  return failed?.type === "sql" ? failed.payload : undefined;
}

/**
 * One run as it happened: SQL, console lines, results and problems in the runtime's
 * event order. What carries no sequence (the default export, an error the runtime
 * could not locate, cleanup failures) comes after the events.
 */
export function buildRunTimeline(result: TimelineInput | undefined, runError?: string): TimelineEntry[] {
  if (!result) {
    return runError ? [{ key: "thrown", kind: "problem", problem: { kind: "thrown", message: runError } }] : [];
  }

  const { errorLocation } = getRunProblems(result);
  const failedQuery = findFailedQuery(result);
  const query = failedQuery?.error?.message;
  // QuickJS keeps no frames past an await, so a query error often has no location; its statement's call site does.
  const queryLocation: Diagnostic | undefined =
    query !== undefined && failedQuery?.source !== undefined
      ? {
          severity: "error",
          message: query,
          source: failedQuery.source,
          ...(failedQuery.line === undefined ? {} : { line: failedQuery.line }),
        }
      : undefined;
  const runErrorProblem = (location = queryLocation): TimelineProblem | undefined =>
    result.error
      ? {
          kind: "error",
          phase: result.error.phase,
          message: result.error.message,
          ...(location ? { location } : {}),
          ...(query === undefined ? {} : { query }),
        }
      : undefined;
  const entries: TimelineEntry[] = [];

  for (const event of result.events.toSorted((left, right) => left.sequence - right.sequence)) {
    const key = `${event.type}-${event.sequence}`;

    if (event.type === "sql") {
      entries.push({ key, kind: "sql", event: event.payload });
    } else if (event.type === "log") {
      entries.push({ key, kind: "console", event: event.payload });
    } else if (event.type === "display") {
      entries.push({
        key,
        kind: "result",
        label: event.payload.label,
        values: event.payload.values,
        source: event.payload.source,
        line: event.payload.line,
      });
    } else {
      const problem = isSameDiagnostic(event.payload, errorLocation)
        ? runErrorProblem(errorLocation)
        : { kind: "diagnostic" as const, diagnostic: event.payload };

      if (problem) {
        entries.push({ key, kind: "problem", problem });
      }
    }
  }

  if (result.value.type !== "undefined") {
    entries.push({
      key: "default",
      kind: "result",
      label: result.displays.length > 0 ? "Default export" : undefined,
      values: [result.value],
    });
  }

  const unlocated = errorLocation ? undefined : runErrorProblem();

  if (unlocated) {
    entries.push({ key: "error", kind: "problem", problem: unlocated });
  }

  result.cleanupErrors.forEach((error, index) => {
    entries.push({ key: `cleanup-${index}`, kind: "problem", problem: { kind: "cleanup", error } });
  });

  return entries;
}

const filterKinds: Record<Exclude<TimelineFilter, "story">, readonly TimelineEntry["kind"][]> = {
  results: ["result"],
  logs: ["console", "sql"],
  problems: ["problem"],
};

/** Story and Logs fold the SQL Drizzle Run sends around the user's code (schema setup, seed, inspection) into groups. */
const foldedPhases: readonly SetupEntry["phase"][] = ["bootstrap", "seed", "inspect"];

/**
 * The rows a filter shows. Story keeps every entry, folds setup SQL and, given the run's transactions, gathers what
 * ran inside each one into its card, then the queries sent outside them into theirs. Logs keeps console lines and
 * SQL in run order, setup folded.
 */
export function filterTimeline(
  entries: readonly TimelineEntry[],
  filter: TimelineFilter,
  story?: StoryInput,
): readonly TimelineRow[] {
  if (filter !== "story" && filter !== "logs") {
    return entries.filter((entry) => filterKinds[filter].includes(entry.kind));
  }

  const kept = filter === "story" ? entries : entries.filter((entry) => filterKinds.logs.includes(entry.kind));
  const rows = foldSetup(kept, foldedPhases);

  if (filter === "logs") {
    return rows;
  }

  const grouped = story?.transactions === undefined ? rows : groupTransactions(rows, story);

  return groupQueries(grouped, entries);
}

/** The Logs rows one filter keeps: console lines, or SQL with its setup groups. */
export function filterLogs(rows: readonly TimelineRow[], filter: LogFilter): readonly TimelineRow[] {
  if (filter === "all") {
    return rows;
  }

  return rows.filter((row) =>
    filter === "console" ? row.kind === "console" : row.kind === "sql" || row.kind === "setup",
  );
}

function isSameCallSite(group: QueryGroup, event: SqlEvent) {
  return group.source === event.source && group.line === event.line;
}

/**
 * Story's query cards
 *
 * Run SQL outside any transaction gathers into one card per call site, in run order. A result fed by one of a card's
 * statements becomes the card's chip instead of a card of its own, since it shows in Results.
 */
function groupQueries(rows: readonly TimelineRow[], entries: readonly TimelineEntry[]): TimelineRow[] {
  const grouped: TimelineRow[] = [];

  for (const row of rows) {
    const previous = grouped.at(-1);

    if (isRunSql(row)) {
      if (previous?.kind === "query" && isSameCallSite(previous, row.event)) {
        grouped[grouped.length - 1] = { ...previous, entries: [...previous.entries, row] };
      } else {
        grouped.push({
          key: `query-${row.key}`,
          kind: "query",
          entries: [row],
          source: row.event.source,
          line: row.event.line,
        });
      }

      continue;
    }

    if (row.kind === "result" && row.label !== undefined) {
      const fed = new Set(getResultStatements(entries, row).map((event) => event.sequence));
      const feeder = grouped.findLastIndex(
        (item) => item.kind === "query" && item.entries.some((entry) => fed.has(entry.event.sequence)),
      );
      const card = grouped[feeder];

      if (card?.kind === "query" && card.display === undefined) {
        grouped[feeder] = { ...card, display: row.label };
        continue;
      }
    }

    grouped.push(row);
  }

  return grouped;
}

type SqlRow = SqlEntry & { event: { phase: "run" } };

function isRunSql(row: TimelineRow): row is SqlRow {
  return row.kind === "sql" && row.event.phase === "run";
}

/** The SQL sequences a transaction sent, its savepoints' included. */
function collectSequences(transaction: RunTransaction, children: TransactionChildren) {
  const sequences = new Set(transaction.statements.map((statement) => statement.sequence));

  for (const child of children.get(transaction.id) ?? []) {
    for (const sequence of collectSequences(child, children)) {
      sequences.add(sequence);
    }
  }

  return sequences;
}

/**
 * Story's transaction groups
 *
 * Each run-phase transaction takes the rows from its first statement to its last, so console lines and results in
 * its callback stay inside its card. A transaction rolled back by a thrown error gets that error as a row before
 * its rollback, unless one of its statements failed and already shows it. Seed transactions stay folded with the
 * seed.
 */
function groupTransactions(rows: readonly TimelineRow[], story: StoryInput): TimelineRow[] {
  const transactions = (story.transactions ?? []).filter((transaction) => transaction.phase === "run");
  const children = getTransactionChildren(transactions);

  const nest = (level: readonly TimelineRow[], siblings: readonly RunTransaction[]): TimelineRow[] => {
    let nested = [...level];

    for (const transaction of siblings) {
      const sequences = collectSequences(transaction, children);
      const first = nested.findIndex((row) => isRunSql(row) && sequences.has(row.event.sequence));
      const last = nested.findLastIndex((row) => isRunSql(row) && sequences.has(row.event.sequence));

      if (first === -1) {
        continue;
      }

      const inside = nest(nested.slice(first, last + 1), children.get(transaction.id) ?? []);
      const roles = new Map(transaction.statements.map((statement) => [statement.sequence, statement.role]));
      const group: TransactionGroup = {
        key: `transaction-${transaction.id}`,
        kind: "transaction",
        transaction,
        rows: placeRollbackCause(inside, transaction, roles),
        roles,
        keptWrites: countKeptWrites(transaction, children),
        stopped: false,
      };

      nested = [...nested.slice(0, first), group, ...nested.slice(last + 1)];
    }

    return nested;
  };

  const grouped = nest(
    rows,
    transactions.filter((transaction) => transaction.parent === undefined),
  );

  const last = grouped.findLastIndex((row) => row.kind === "transaction");
  const lastGroup = grouped[last];
  const ranAfter = grouped.slice(last + 1).some(isRunSql);

  if (
    story.outcome === "failed" &&
    lastGroup?.kind === "transaction" &&
    lastGroup.transaction.reason === "error" &&
    !ranAfter
  ) {
    grouped[last] = { ...lastGroup, stopped: true };
  }

  return grouped;
}

function placeRollbackCause(
  rows: readonly TimelineRow[],
  transaction: RunTransaction,
  roles: ReadonlyMap<number, TransactionStatementRole>,
): readonly TimelineRow[] {
  const error = transaction.error;
  const statementFailed = rows.some((row) => row.kind === "sql" && row.event.outcome === "failed");

  if (transaction.reason !== "error" || error === undefined || statementFailed) {
    return rows;
  }

  const rollback = rows.findIndex((row) => {
    const role = isRunSql(row) ? roles.get(row.event.sequence) : undefined;

    return role === "rollback" || role === "rollback_to";
  });
  const at = rollback === -1 ? rows.length : rollback;
  const cause: RollbackCause = { key: `rollback-cause-${transaction.id}`, kind: "rollback_cause", error };

  return [...rows.slice(0, at), cause, ...rows.slice(at)];
}

/** Whether a setup SQL statement joins the group before it: the same phase, or the seed right after schema setup. */
function joinsSetupGroup(group: SetupEntry, phase: SetupEntry["phase"]): boolean {
  return group.phase === phase || (group.phase === "bootstrap" && phase === "seed");
}

/**
 * Fold setup SQL into groups
 *
 * Schema setup and the following seed fold into one seed group. Without a seed, schema setup keeps its own group.
 */
function foldSetup(entries: readonly TimelineEntry[], folded: readonly SetupEntry["phase"][]): TimelineRow[] {
  const rows: TimelineRow[] = [];

  for (const entry of entries) {
    if (entry.kind !== "sql" || entry.event.phase === "run" || !folded.includes(entry.event.phase)) {
      rows.push(entry);
      continue;
    }

    const previous = rows.at(-1);
    const group =
      previous?.kind === "setup" && joinsSetupGroup(previous, entry.event.phase)
        ? previous
        : {
            key: `setup-${entry.key}`,
            kind: "setup" as const,
            phase: entry.event.phase,
            entries: [],
            executed: 0,
            durationMs: undefined,
          };
    const duration = entry.event.durationMs;
    const next: SetupEntry = {
      ...group,
      phase: entry.event.phase,
      entries: [...group.entries, entry],
      executed: group.executed + (entry.event.kind === "executed" ? 1 : 0),
      durationMs: duration === undefined ? group.durationMs : (group.durationMs ?? 0) + duration,
    };

    if (group === previous) {
      rows[rows.length - 1] = next;
    } else {
      rows.push(next);
    }
  }

  return rows;
}

type ResultEntry = Extract<TimelineEntry, { kind: "result" }>;

/**
 * The SQL behind a result card: the statements the run executed on the result's own
 * line since the previous result, or else the last one it executed before it.
 */
export function getResultStatements(entries: readonly TimelineEntry[], result: ResultEntry): SqlEvent[] {
  const index = entries.indexOf(result);
  const statements: SqlEvent[] = [];

  for (const entry of entries.slice(0, Math.max(index, 0))) {
    if (entry.kind === "result") {
      statements.length = 0;
    } else if (entry.kind === "sql" && entry.event.phase === "run" && entry.event.kind === "executed") {
      statements.push(entry.event);
    }
  }

  const sameLine =
    result.line === undefined
      ? []
      : statements.filter(
          (event) => event.line === result.line && (event.source === undefined || event.source === result.source),
        );

  if (sameLine.length > 0) {
    return sameLine;
  }

  return statements.slice(-1);
}

/** The tab and filter chips. SQL counts executed statements, as the database saw them; Logs adds console lines. */
export function countTimeline(entries: readonly TimelineEntry[]): TimelineCounts {
  const counts: TimelineCounts = { results: 0, logs: 0, console: 0, sql: 0, problems: 0 };

  for (const entry of entries) {
    if (entry.kind === "sql") {
      counts.sql += entry.event.kind === "executed" ? 1 : 0;
    } else if (entry.kind === "result") {
      counts.results += 1;
    } else if (entry.kind === "console") {
      counts.console += 1;
    } else {
      counts.problems += 1;
    }
  }

  counts.logs = counts.console + counts.sql;

  return counts;
}
