import {
  RUN_ERROR_DIAGNOSTIC_CODE,
  serializeValue,
  type Diagnostic,
  type LogEvent,
  type RunEvent,
  type RunTransaction,
  type SqlEvent,
} from "@drizzle-run/core/contracts";
import { describe, expect, it } from "vitest";

import {
  buildRunTimeline,
  countTimeline,
  filterLogs,
  filterTimeline,
  getResultStatements,
  type TimelineEntry,
  type TimelineInput,
  type TimelineRow,
} from "./run-timeline";

function makeSqlEvent(
  kind: SqlEvent["kind"] = "executed",
  phase: SqlEvent["phase"] = "run",
  durationMs?: number,
): SqlEvent {
  return {
    sequence: 1,
    phase,
    ...(durationMs === undefined ? {} : { durationMs }),
    origin: "drizzle",
    kind,
    sql: "select 1",
    parameters: [],
    outcome: "succeeded",
  };
}

const log: LogEvent = { sequence: 1, phase: "run", level: "log", values: [serializeValue("hi")] };
const usersDisplay = { label: "Users", values: [serializeValue([{ id: 1 }])] };
const located: Diagnostic = {
  severity: "error",
  code: RUN_ERROR_DIAGNOSTIC_CODE,
  message: "boom",
  source: "query.ts",
  line: 4,
  column: 31,
};
const warning: Diagnostic = { severity: "warning", message: "Unused import" };

function makeTimelineInput(events: RunEvent[], extra: Partial<TimelineInput> = {}): TimelineInput {
  return {
    events,
    value: serializeValue(undefined),
    displays: events.flatMap((event) => (event.type === "display" ? [event.payload] : [])),
    diagnostics: events.flatMap((event) => (event.type === "diagnostic" ? [event.payload] : [])),
    cleanupErrors: [],
    ...extra,
  };
}

function listKinds(entries: readonly TimelineRow[]) {
  return entries.map((entry) => entry.kind);
}

describe("buildRunTimeline", () => {
  it("should show a compiler diagnostic once as a located compile error", () => {
    const diagnostic: Diagnostic = {
      severity: "error",
      message: 'Unexpected ";"',
      source: "query.ts",
      line: 1,
      column: 16,
    };
    const result = makeTimelineInput([{ type: "diagnostic", sequence: 1, payload: diagnostic }], {
      error: { phase: "compile", name: "CompilationError", message: diagnostic.message },
    });

    expect(buildRunTimeline(result)).toEqual([
      {
        key: "diagnostic-1",
        kind: "problem",
        problem: { kind: "error", phase: "compile", message: diagnostic.message, location: diagnostic },
      },
    ]);
  });

  it("should order entries by the runtime event sequence across kinds", () => {
    const entries = buildRunTimeline(
      makeTimelineInput([
        { type: "display", sequence: 3, payload: usersDisplay },
        { type: "log", sequence: 1, payload: log },
        { type: "sql", sequence: 2, payload: makeSqlEvent() },
      ]),
    );

    expect(listKinds(entries)).toEqual(["console", "sql", "result"]);
  });

  it("should show the run error where its located diagnostic happened, once", () => {
    const entries = buildRunTimeline(
      makeTimelineInput(
        [
          { type: "sql", sequence: 1, payload: makeSqlEvent() },
          { type: "diagnostic", sequence: 2, payload: located },
          { type: "log", sequence: 3, payload: log },
        ],
        { error: { phase: "run", name: "Error", message: "boom" } },
      ),
    );

    expect(listKinds(entries)).toEqual(["sql", "problem", "console"]);
    expect(entries[1]).toMatchObject({
      kind: "problem",
      problem: { kind: "error", phase: "run", message: "boom", location: located },
    });
  });

  it("should keep what the database said and where, when a failed statement threw the run error", () => {
    const failed = {
      ...makeSqlEvent(),
      source: "query.ts",
      line: 7,
      outcome: "failed" as const,
      error: { name: "error", message: 'relation "accounts" does not exist' },
    };
    const wrapped = {
      phase: "run" as const,
      name: "DrizzleQueryError",
      message: "Failed query: select 1",
      cause: failed.error,
    };
    const thrownAfter = { phase: "run" as const, name: "Error", message: "Changed our mind" };

    const [query] = buildRunTimeline(
      makeTimelineInput([{ type: "sql", sequence: 1, payload: failed }], { error: wrapped }),
    ).filter((entry) => entry.kind === "problem");
    const [caught] = buildRunTimeline(
      makeTimelineInput([{ type: "sql", sequence: 1, payload: failed }], { error: thrownAfter }),
    ).filter((entry) => entry.kind === "problem");

    expect(query).toMatchObject({
      problem: {
        kind: "error",
        query: 'relation "accounts" does not exist',
        location: { severity: "error", source: "query.ts", line: 7 },
      },
    });
    expect(caught).toMatchObject({ problem: { kind: "error", message: "Changed our mind" } });
    expect(caught?.kind === "problem" && caught.problem.kind === "error" && caught.problem.query).toBeUndefined();
  });

  it("should match the located diagnostic by value, not by object identity", () => {
    const entries = buildRunTimeline(
      makeTimelineInput([{ type: "diagnostic", sequence: 1, payload: { ...located } }], {
        diagnostics: [located],
        error: { phase: "run", name: "Error", message: "boom" },
      }),
    );

    expect(entries).toMatchObject([{ kind: "problem", problem: { kind: "error", message: "boom" } }]);
  });

  it("should put what has no sequence after the events: the default export, an unlocated error, then cleanup errors", () => {
    const entries = buildRunTimeline(
      makeTimelineInput(
        [
          { type: "diagnostic", sequence: 1, payload: warning },
          { type: "display", sequence: 2, payload: usersDisplay },
        ],
        {
          value: serializeValue(7),
          error: { phase: "cleanup", name: "Error", message: "late" },
          cleanupErrors: [{ name: "Error", message: "socket" }],
        },
      ),
    );

    expect(entries.map((entry) => (entry.kind === "problem" ? entry.problem.kind : entry.kind))).toEqual([
      "diagnostic",
      "result",
      "result",
      "error",
      "cleanup",
    ]);
    expect(entries[2]).toMatchObject({ kind: "result", label: "Default export" });
  });

  it("should leave the default export unlabelled when nothing was displayed", () => {
    expect(buildRunTimeline(makeTimelineInput([], { value: serializeValue(7) }))).toMatchObject([
      { kind: "result", label: undefined },
    ]);
  });

  it("should be one problem when the run throws before a result", () => {
    expect(buildRunTimeline(undefined, "Worker crashed")).toMatchObject([
      { kind: "problem", problem: { kind: "thrown", message: "Worker crashed" } },
    ]);
  });

  it("should be empty before the first run", () => {
    expect(buildRunTimeline(undefined)).toEqual([]);
  });
});

describe("countTimeline", () => {
  it("should count results, console lines, executed SQL, and problems", () => {
    const entries = buildRunTimeline(
      makeTimelineInput(
        [
          { type: "sql", sequence: 1, payload: makeSqlEvent("generated") },
          { type: "sql", sequence: 2, payload: makeSqlEvent() },
          { type: "log", sequence: 3, payload: log },
          { type: "display", sequence: 4, payload: usersDisplay },
          { type: "diagnostic", sequence: 5, payload: warning },
        ],
        { error: { phase: "run", name: "Error", message: "boom" } },
      ),
    );

    expect(countTimeline(entries)).toEqual({ results: 1, logs: 2, console: 1, sql: 1, problems: 2 });
  });

  it("should count a run error and its located diagnostic once", () => {
    const entries = buildRunTimeline(
      makeTimelineInput([{ type: "diagnostic", sequence: 1, payload: located }], {
        error: { phase: "run", name: "Error", message: "boom" },
      }),
    );

    expect(countTimeline(entries).problems).toBe(1);
  });

  it("should count a thrown run as one problem, and nothing before the first run", () => {
    expect(countTimeline(buildRunTimeline(undefined, "Worker crashed"))).toEqual({
      results: 0,
      logs: 0,
      console: 0,
      sql: 0,
      problems: 1,
    });
    expect(countTimeline(buildRunTimeline(undefined))).toEqual({
      results: 0,
      logs: 0,
      console: 0,
      sql: 0,
      problems: 0,
    });
  });
});

describe("filterTimeline", () => {
  const entries = buildRunTimeline(
    makeTimelineInput([
      { type: "sql", sequence: 1, payload: makeSqlEvent() },
      { type: "log", sequence: 2, payload: log },
      { type: "display", sequence: 3, payload: usersDisplay },
      { type: "diagnostic", sequence: 4, payload: warning },
    ]),
  );

  it("should keep every entry for Story (a fed result as its query card's chip), console lines and SQL for Logs", () => {
    expect(listKinds(filterTimeline(entries, "story"))).toEqual(["query", "console", "problem"]);
    expect(listKinds(filterTimeline(entries, "results"))).toEqual(["result"]);
    expect(listKinds(filterTimeline(entries, "logs"))).toEqual(["sql", "console"]);
    expect(listKinds(filterTimeline(entries, "problems"))).toEqual(["problem"]);
  });
});

describe("filterLogs", () => {
  const entries = buildRunTimeline(
    makeTimelineInput([
      { type: "sql", sequence: 1, payload: makeSqlEvent("executed", "seed", 2) },
      { type: "sql", sequence: 2, payload: makeSqlEvent() },
      { type: "log", sequence: 3, payload: log },
    ]),
  );
  const rows = filterTimeline(entries, "logs");

  it("should keep every row for All, console lines for Console, and SQL with its setup groups for SQL", () => {
    expect(listKinds(filterLogs(rows, "all"))).toEqual(["setup", "sql", "console"]);
    expect(listKinds(filterLogs(rows, "console"))).toEqual(["console"]);
    expect(listKinds(filterLogs(rows, "sql"))).toEqual(["setup", "sql"]);
  });
});

describe("filterTimeline for Story", () => {
  it("should fold schema setup and the seed after it into one entry, and keep the run's own SQL", () => {
    const entries = buildRunTimeline(
      makeTimelineInput([
        { type: "sql", sequence: 1, payload: makeSqlEvent("generated", "bootstrap") },
        { type: "sql", sequence: 2, payload: makeSqlEvent("executed", "bootstrap", 1) },
        { type: "sql", sequence: 3, payload: makeSqlEvent("executed", "seed", 2) },
        { type: "sql", sequence: 4, payload: makeSqlEvent("executed", "seed", 3) },
        { type: "sql", sequence: 5, payload: makeSqlEvent() },
        { type: "log", sequence: 6, payload: log },
      ]),
    );
    const all = filterTimeline(entries, "story");

    expect(listKinds(all)).toEqual(["setup", "query", "console"]);
    expect(all[0]).toMatchObject({ kind: "setup", phase: "seed", executed: 3, durationMs: 6 });
    expect(all[0]?.kind === "setup" && all[0].entries.map((entry) => entry.key)).toEqual([
      "sql-1",
      "sql-2",
      "sql-3",
      "sql-4",
    ]);
  });

  it("should fold schema setup, seed and inspection on the Logs tab, and keep each run statement's row", () => {
    const entries = buildRunTimeline(
      makeTimelineInput([
        { type: "sql", sequence: 1, payload: makeSqlEvent("executed", "bootstrap", 1) },
        { type: "sql", sequence: 2, payload: makeSqlEvent("executed", "bootstrap", 2) },
        { type: "sql", sequence: 3, payload: makeSqlEvent("executed", "seed", 2) },
        { type: "sql", sequence: 4, payload: makeSqlEvent() },
        { type: "sql", sequence: 5, payload: makeSqlEvent("executed", "inspect", 1) },
      ]),
    );
    const rows = filterTimeline(entries, "logs");

    expect(
      rows.map((row) =>
        row.kind === "sql" ? row.event.phase : row.kind === "setup" ? `setup:${row.phase}` : row.kind,
      ),
    ).toEqual(["setup:seed", "run", "setup:inspect"]);
    expect(rows[0]).toMatchObject({ executed: 3, durationMs: 5 });
  });

  it("should keep schema setup as its own entry when no seed follows it", () => {
    const entries = buildRunTimeline(
      makeTimelineInput([
        { type: "sql", sequence: 1, payload: makeSqlEvent("executed", "bootstrap", 1) },
        { type: "sql", sequence: 2, payload: makeSqlEvent() },
      ]),
    );

    expect(filterTimeline(entries, "logs")).toMatchObject([{ kind: "setup", phase: "bootstrap" }, { kind: "sql" }]);
  });
});

const describeRows = (rows: readonly TimelineRow[]): unknown[] =>
  rows.map((row) =>
    row.kind === "transaction"
      ? { [`transaction-${row.transaction.id}`]: describeRows(row.rows) }
      : row.kind === "query"
        ? { query: row.entries.map((entry) => entry.event.sql), display: row.display }
        : row.kind === "sql"
          ? row.event.sql
          : row.kind,
  );

const makeTransaction = (options: Partial<RunTransaction> & Pick<RunTransaction, "id">): RunTransaction => ({
  phase: "run",
  outcome: "committed",
  writes: "kept",
  statements: [],
  durationMs: 1,
  ...options,
});

const statementEvent = (sequence: number, sql: string, outcome: SqlEvent["outcome"] = "succeeded"): RunEvent => ({
  type: "sql",
  sequence,
  payload: { ...makeSqlEvent(), sequence, sql, outcome },
});

describe("filterTimeline for Story with transactions", () => {
  const bankTransfer = [
    statementEvent(1, "begin"),
    statementEvent(2, "update accounts set balance = balance - 30"),
    statementEvent(3, "savepoint sp1"),
    statementEvent(4, "update accounts set balance = 0"),
    statementEvent(5, "rollback to savepoint sp1"),
    { type: "log", sequence: 6, payload: log },
    statementEvent(7, "commit"),
    statementEvent(8, "select * from accounts"),
  ] satisfies RunEvent[];
  const transfer = makeTransaction({
    id: 1,
    statements: [
      { sequence: 1, role: "begin" },
      { sequence: 2, role: "write" },
      { sequence: 7, role: "commit" },
    ],
  });
  const savepoint = makeTransaction({
    id: 2,
    parent: 1,
    outcome: "rolled_back",
    reason: "error",
    error: { name: "Error", message: "Changed our mind", source: "query.ts", line: 14 },
    writes: "undone",
    statements: [
      { sequence: 3, role: "savepoint" },
      { sequence: 4, role: "write" },
      { sequence: 5, role: "rollback_to" },
    ],
  });

  it("should gather what ran inside each transaction and nest its savepoint, the thrown error before its rollback", () => {
    const entries = buildRunTimeline(makeTimelineInput(bankTransfer));

    const rows = filterTimeline(entries, "story", { transactions: [transfer, savepoint], outcome: "succeeded" });

    expect(describeRows(rows)).toEqual([
      {
        "transaction-1": [
          "begin",
          "update accounts set balance = balance - 30",
          {
            "transaction-2": [
              "savepoint sp1",
              "update accounts set balance = 0",
              "rollback_cause",
              "rollback to savepoint sp1",
            ],
          },
          "console",
          "commit",
        ],
      },
      { query: ["select * from accounts"], display: undefined },
    ]);
    expect(rows[0]).toMatchObject({ kind: "transaction", keptWrites: 1, stopped: false });
  });

  it("should leave out the thrown error when a failed statement already shows it, and mark where a failed run stopped", () => {
    const entries = buildRunTimeline(
      makeTimelineInput([
        statementEvent(1, "begin"),
        statementEvent(2, "update accounts set balance = balance - 30", "failed"),
        statementEvent(3, "rollback"),
      ]),
    );
    const failed = makeTransaction({
      id: 1,
      outcome: "rolled_back",
      reason: "error",
      error: { name: "DrizzleQueryError", message: "Failed query" },
      writes: "undone",
      statements: [
        { sequence: 1, role: "begin" },
        { sequence: 2, role: "write" },
        { sequence: 3, role: "rollback" },
      ],
    });

    const rows = filterTimeline(entries, "story", { transactions: [failed], outcome: "failed" });

    expect(describeRows(rows)).toEqual([
      { "transaction-1": ["begin", "update accounts set balance = balance - 30", "rollback"] },
    ]);
    expect(rows[0]).toMatchObject({ stopped: true, keptWrites: 0 });
  });

  it("should keep the rows as they are without transactions, on other tabs, and for seed transactions", () => {
    const entries = buildRunTimeline(makeTimelineInput(bankTransfer));
    const seeded = { transactions: [{ ...transfer, phase: "seed" as const }], outcome: "succeeded" as const };

    expect(filterTimeline(entries, "story", { outcome: "succeeded" })).toEqual(filterTimeline(entries, "story"));
    expect(filterTimeline(entries, "logs", { transactions: [transfer], outcome: "succeeded" })).toEqual(
      filterTimeline(entries, "logs"),
    );
    expect(filterTimeline(entries, "story", seeded)).toEqual(filterTimeline(entries, "story"));
  });
});

function makeQueryEvent(sequence: number, sql: string, line: number): RunEvent {
  return {
    type: "sql",
    sequence,
    payload: { ...makeSqlEvent(), sequence, sql, source: "query.ts", line },
  };
}

describe("filterTimeline for Story query cards", () => {
  it("should gather a call site's statements into one card and make the result they fed its chip", () => {
    const entries = buildRunTimeline(
      makeTimelineInput([
        makeQueryEvent(1, "select * from users", 4),
        makeQueryEvent(2, "select * from posts", 4),
        { type: "display", sequence: 3, payload: { ...usersDisplay, source: "query.ts", line: 4 } },
        makeQueryEvent(4, "delete from users", 6),
        { type: "log", sequence: 5, payload: log },
      ]),
    );

    expect(describeRows(filterTimeline(entries, "story"))).toEqual([
      { query: ["select * from users", "select * from posts"], display: "Users" },
      { query: ["delete from users"], display: undefined },
      "console",
    ]);
  });

  it("should keep a result its own card when no query card fed it", () => {
    const entries = buildRunTimeline(makeTimelineInput([{ type: "display", sequence: 1, payload: usersDisplay }]));

    expect(describeRows(filterTimeline(entries, "story"))).toEqual(["result"]);
  });
});

const findResult = (entries: TimelineEntry[], label: string) => {
  const entry = entries.find(
    (item): item is Extract<TimelineEntry, { kind: "result" }> => item.kind === "result" && item.label === label,
  );

  if (!entry) {
    throw new Error(`No result ${label}`);
  }

  return entry;
};

const makeDisplay = (label: string, line?: number) => ({
  label,
  values: usersDisplay.values,
  source: "query.ts",
  ...(line === undefined ? {} : { line }),
});

const makeStatement = (
  text: string,
  line?: number,
  phase: SqlEvent["phase"] = "run",
  kind: SqlEvent["kind"] = "executed",
): SqlEvent => ({
  ...makeSqlEvent(kind, phase),
  sql: text,
  source: "query.ts",
  ...(line === undefined ? {} : { line }),
});

describe("getResultStatements", () => {
  it("should take the statements run on the result's own line", () => {
    const entries = buildRunTimeline(
      makeTimelineInput([
        { type: "sql", sequence: 1, payload: makeStatement("insert", 3) },
        { type: "sql", sequence: 2, payload: makeStatement("select users", 5) },
        { type: "display", sequence: 3, payload: makeDisplay("Users", 5) },
      ]),
    );

    expect(getResultStatements(entries, findResult(entries, "Users")).map((event) => event.sql)).toEqual([
      "select users",
    ]);
  });

  it("should fall back to the last statement since the previous result, and skip setup and generated SQL", () => {
    const entries = buildRunTimeline(
      makeTimelineInput([
        { type: "sql", sequence: 1, payload: makeStatement("create table", 1, "bootstrap") },
        { type: "sql", sequence: 2, payload: makeStatement("select first", 2) },
        { type: "display", sequence: 3, payload: makeDisplay("First", 9) },
        { type: "sql", sequence: 4, payload: makeStatement("select second", 4) },
        { type: "sql", sequence: 5, payload: makeStatement("generated", 4, "run", "generated") },
        { type: "display", sequence: 6, payload: makeDisplay("Second", 9) },
        { type: "display", sequence: 7, payload: makeDisplay("Third", 9) },
      ]),
    );

    expect(getResultStatements(entries, findResult(entries, "First")).map((event) => event.sql)).toEqual([
      "select first",
    ]);
    expect(getResultStatements(entries, findResult(entries, "Second")).map((event) => event.sql)).toEqual([
      "select second",
    ]);
    expect(getResultStatements(entries, findResult(entries, "Third"))).toEqual([]);
  });
});
