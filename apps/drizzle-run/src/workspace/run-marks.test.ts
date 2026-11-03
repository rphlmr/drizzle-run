import type { Diagnostic, RunResult } from "@drizzle-run/core/contracts";
import { RUN_ERROR_DIAGNOSTIC_CODE } from "@drizzle-run/core/contracts";
import { describe, expect, it } from "vitest";

import type { RunNote } from "../ui/run-notes";
import { getEditorRunNotes, getRunErrorMark } from "./run-marks";

const runError = { name: "Error", message: "boom", phase: "run" } satisfies RunResult["error"];

/** A failed run whose error a diagnostic places at query.ts:7, unless the case says otherwise. */
function makeFailedRun({
  diagnostics = [
    { severity: "error", code: RUN_ERROR_DIAGNOSTIC_CODE, message: "boom", source: "query.ts", line: 7, column: 3 },
  ],
}: { diagnostics?: readonly Diagnostic[] } = {}): Pick<RunResult, "diagnostics" | "error"> {
  return { diagnostics, error: runError };
}

/** A run with one committed transaction opened at query.ts:4. */
function makeTransactionRun(): Pick<RunResult, "transactions"> {
  return {
    transactions: [
      {
        id: 1,
        phase: "run",
        source: "query.ts",
        line: 4,
        outcome: "committed",
        writes: "kept",
        statements: [],
        durationMs: 3,
      },
    ],
  };
}

const stepNote: RunNote = { kind: "chip", path: "query.ts", line: 2, text: "Removed here", tone: "plain" };

describe("getRunErrorMark", () => {
  it("should have no mark before a first run", () => {
    expect(getRunErrorMark(undefined)).toBeUndefined();
  });

  it("should mark the line the run error points at", () => {
    expect(getRunErrorMark(makeFailedRun())).toEqual({ path: "query.ts", line: 7, message: "boom" });
  });

  it("should have no mark when no diagnostic locates the error", () => {
    expect(getRunErrorMark(makeFailedRun({ diagnostics: [] }))).toBeUndefined();
  });

  it("should have no mark when the located error has no line", () => {
    const run = makeFailedRun({
      diagnostics: [{ severity: "error", code: RUN_ERROR_DIAGNOSTIC_CODE, message: "boom", source: "query.ts" }],
    });

    expect(getRunErrorMark(run)).toBeUndefined();
  });

  it("should not take a compile error with the same message for the run error's location", () => {
    const run = makeFailedRun({
      diagnostics: [{ severity: "error", message: "boom", source: "query.ts", line: 7, column: 3 }],
    });

    expect(getRunErrorMark(run)).toBeUndefined();
  });

  it("should have no mark for a run without an error", () => {
    expect(getRunErrorMark({ diagnostics: makeFailedRun().diagnostics })).toBeUndefined();
  });
});

describe("getEditorRunNotes", () => {
  it("should leave no run notes before a first run, only the step's", () => {
    expect(getEditorRunNotes(undefined, "playground", [stepNote])).toEqual([stepNote]);
  });

  it("should leave no run notes when they are off", () => {
    expect(getEditorRunNotes(makeTransactionRun(), "off")).toEqual([]);
  });

  it("should put the playground's transaction chips before the step's notes", () => {
    const notes = getEditorRunNotes(makeTransactionRun(), "playground", [stepNote]);

    expect(notes).toEqual([
      { kind: "chip", path: "query.ts", line: 4, text: "committed · 0 queries", detail: "3 ms", tone: "ok" },
      stepNote,
    ]);
  });

  it("should say what a guide's commit kept", () => {
    expect(getEditorRunNotes(makeTransactionRun(), "guided")).toEqual([
      { kind: "chip", path: "query.ts", line: 4, text: "committed", tone: "ok" },
    ]);
  });
});
