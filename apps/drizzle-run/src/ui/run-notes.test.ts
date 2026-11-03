import { serializeValue, type RunResult, type RunTransaction } from "@drizzle-run/core/contracts";
import { describe, expect, it } from "vitest";

import { getRunNotes, getStepNotes } from "./run-notes";

function makeTransaction(options: Partial<RunTransaction> & Pick<RunTransaction, "id">): RunTransaction {
  return {
    phase: "run",
    source: "query.ts",
    outcome: "committed",
    writes: "kept",
    statements: [],
    durationMs: 9.4,
    ...options,
  };
}

/** The transactions example: a transfer with a savepoint that throws, then a transaction that calls rollback. */
function makeBankRun(options: Partial<Pick<RunResult, "transactions" | "logs" | "displays">> = {}) {
  return {
    transactions: [
      makeTransaction({
        id: 1,
        line: 6,
        statements: [
          { sequence: 1, role: "begin" },
          { sequence: 2, role: "write" },
          { sequence: 3, role: "write" },
          { sequence: 7, role: "commit" },
        ],
      }),
      makeTransaction({
        id: 2,
        parent: 1,
        line: 12,
        outcome: "rolled_back",
        reason: "error",
        writes: "undone",
        statements: [
          { sequence: 4, role: "savepoint" },
          { sequence: 5, role: "write" },
          { sequence: 6, role: "rollback_to" },
        ],
      }),
      makeTransaction({ id: 3, line: 23, outcome: "rolled_back", reason: "rollback_call", writes: "undone" }),
    ],
    logs: [
      {
        sequence: 8,
        phase: "run",
        level: "log",
        values: [serializeValue("Rolled back:"), serializeValue({ a: 1 })],
        source: "query.ts",
        line: 17,
      },
      { sequence: 9, phase: "seed", level: "log", values: [serializeValue("seeding")], source: "seed.ts", line: 3 },
    ],
    displays: [{ label: "Balances", values: [serializeValue([{ id: 1 }, { id: 2 }])], source: "query.ts", line: 31 }],
    ...options,
  } satisfies Pick<RunResult, "transactions" | "logs" | "displays">;
}

describe("getRunNotes", () => {
  it("should chip each transaction line and leave console output and results to the output", () => {
    expect(getRunNotes(makeBankRun())).toEqual([
      { kind: "chip", path: "query.ts", line: 6, text: "committed · 3 queries", detail: "9 ms", tone: "ok" },
      { kind: "chip", path: "query.ts", line: 12, text: "savepoint rolled back", tone: "err" },
      { kind: "chip", path: "query.ts", line: 23, text: "rolled back · nothing kept", tone: "err" },
    ]);
  });

  it("should say how many writes a guide's commit kept", () => {
    const run = makeBankRun();
    const [transfer, savepoint] = run.transactions;
    const released = {
      ...run,
      transactions: [transfer, { ...savepoint, outcome: "committed" as const, writes: "kept" as const }],
    };

    expect(getRunNotes(released, { guided: true })).toEqual([
      { kind: "chip", path: "query.ts", line: 6, text: "committed · 3 writes kept", tone: "ok" },
      { kind: "chip", path: "query.ts", line: 12, text: "savepoint released", tone: "ok" },
    ]);
  });

  it("should give a line run in a loop one chip", () => {
    const loop = makeTransaction({ id: 1, line: 4 });
    const run = makeBankRun({ transactions: [loop, { ...loop, id: 2 }] });

    expect(getRunNotes(run)).toEqual([
      { kind: "chip", path: "query.ts", line: 4, text: "committed · 0 queries", detail: "9 ms", tone: "ok" },
    ]);
  });

  it("should leave out seed transactions and calls without a line", () => {
    const run = makeBankRun({
      transactions: [makeTransaction({ id: 1, line: 2, phase: "seed" }), makeTransaction({ id: 2 })],
      displays: [{ label: "Total", values: [serializeValue(3)] }],
      logs: [],
    });

    expect(getRunNotes(run)).toEqual([]);
  });
});

describe("getStepNotes", () => {
  const before = { "query.ts": "a\nb\nthrow\nc\n", "schema.ts": "s\n" };
  const after = { "query.ts": "a\nb\nc\n", "schema.ts": "s\n" };

  it("should draw the lines a step takes out where they were before it runs, with the step's line notes", () => {
    const notes = getStepNotes({
      before,
      after,
      index: 1,
      ran: false,
      meta: { lineNotes: [{ file: "query.ts", match: "c", text: "shows up in Results" }] },
    });

    expect(notes).toEqual([
      {
        kind: "removed",
        path: "query.ts",
        afterLine: 2,
        firstLine: 3,
        lines: ["throw"],
        label: "removed when you run step 2",
      },
      { kind: "chip", path: "query.ts", line: 3, text: "shows up in Results", tone: "plain" },
    ]);
  });

  it("should mark where the lines were once the step ran, named by the step's meta", () => {
    expect(getStepNotes({ before, after, index: 1, ran: true, meta: { removed: "the throw" } })).toEqual([
      { kind: "separator", path: "query.ts", afterLine: 2, label: "step 2 removed the throw" },
    ]);
  });

  it("should leave replaced and added lines to the step's highlight", () => {
    const notes = getStepNotes({
      before: { "query.ts": "a\nold\nb\n" },
      after: { "query.ts": "a\nnew\nb\nadded\n" },
      index: 2,
      ran: false,
    });

    expect(notes).toEqual([]);
  });
});
