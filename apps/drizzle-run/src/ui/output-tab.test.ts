import { serializeValue } from "@drizzle-run/core/contracts";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_OUTPUT_TAB,
  formatRunAge,
  formatRunDuration,
  getOfferedTab,
  getRunProblems,
  getTabAfterRun,
  readOutputTab,
  summarizeRun,
} from "./output-tab";

describe("getRunProblems", () => {
  it("should fold the primary compiler diagnostic into the compile error card", () => {
    const primary = { severity: "error" as const, message: 'Unexpected ";"', source: "query.ts", line: 1, column: 16 };
    const secondary = { severity: "error" as const, message: "Another compile failure", source: "schema.ts", line: 2 };

    const problems = getRunProblems({
      diagnostics: [primary, secondary],
      error: { name: "Error", phase: "compile", message: primary.message },
    });

    expect(problems.errorLocation).toBe(primary);
    expect(problems.diagnostics).toEqual([secondary]);
  });
});

describe("getTabAfterRun", () => {
  it("should open problems after a failed or thrown run", () => {
    expect(getTabAfterRun("problems", "results")).toBe("problems");
    expect(getTabAfterRun("problems", "logs")).toBe("problems");
  });

  it("should leave Problems for Results after a success, and keep any other tab", () => {
    expect(getTabAfterRun("results", "problems")).toBe("results");
    expect(getTabAfterRun("results", "story")).toBe("story");
    expect(getTabAfterRun("results", "logs")).toBe("logs");
  });

  it("should change nothing after a cancelled run", () => {
    expect(getTabAfterRun(undefined, "problems")).toBe("problems");
    expect(getTabAfterRun(undefined, "debug")).toBe("debug");
  });
});

describe("getOfferedTab", () => {
  const embed = ["results", "story", "logs"] as const;

  it("should keep an offered view", () => {
    expect(getOfferedTab("logs", embed)).toBe("logs");
  });

  it("should show a failed run's error in Story when Problems is not offered", () => {
    expect(getOfferedTab(getTabAfterRun("problems", "results"), embed)).toBe("story");
  });

  it("should fall back to Story for a view the panel lacks", () => {
    expect(getOfferedTab("problems", embed)).toBe("story");
  });
});

describe("readOutputTab", () => {
  it("should open on Results by default", () => {
    expect(DEFAULT_OUTPUT_TAB).toBe("results");
  });

  it("should read a tab name and nothing else", () => {
    expect(readOutputTab("logs")).toBe("logs");
    expect(readOutputTab("story")).toBe("story");
    expect(readOutputTab("sql")).toBeUndefined();
    expect(readOutputTab("problems")).toBe("problems");
    expect(readOutputTab("timeline")).toBeUndefined();
    expect(readOutputTab(undefined)).toBeUndefined();
  });
});

describe("formatRunDuration", () => {
  it("should show milliseconds under a second and tenths of a second above", () => {
    expect(formatRunDuration(184)).toBe("184 ms");
    expect(formatRunDuration(92.4)).toBe("92 ms");
    expect(formatRunDuration(2450)).toBe("2.5 s");
  });
});

describe("run picker lines", () => {
  it("should say how long ago a run settled", () => {
    const now = 10 * 60 * 60_000;

    expect(formatRunAge(now - 30_000, now)).toBe("now");
    expect(formatRunAge(now - 2 * 60_000, now)).toBe("2 min ago");
    expect(formatRunAge(now - 90 * 60_000, now)).toBe("1 h ago");
  });

  it("should summarize a run by its first result, or by why it failed", () => {
    const users = { label: "Balances", values: [serializeValue([{ id: 1 }, { id: 2 }])] };
    const total = { label: "Total", values: [serializeValue(3)] };

    expect(summarizeRun({ result: { outcome: "succeeded", displays: [users], error: undefined }, error: "" })).toBe(
      "Balances · 2 rows",
    );
    expect(
      summarizeRun({ result: { outcome: "succeeded", displays: [total, users], error: undefined }, error: "" }),
    ).toBe("Total and 1 more");
    expect(summarizeRun({ result: { outcome: "succeeded", displays: [], error: undefined }, error: "" })).toBe(
      "Nothing displayed",
    );
    expect(
      summarizeRun({
        result: {
          outcome: "failed",
          displays: [],
          error: { phase: "run", name: "Error", message: 'relation "accounts" does not exist' },
        },
        error: "",
      }),
    ).toBe('relation "accounts" does not exist');
    expect(summarizeRun({ result: undefined, error: "worker crashed" })).toBe("worker crashed");
    expect(summarizeRun({ result: { outcome: "cancelled", displays: [], error: undefined }, error: "" })).toBe(
      "Cancelled",
    );
  });
});
