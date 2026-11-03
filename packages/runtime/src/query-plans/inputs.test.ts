import { serializeValue } from "@drizzle-run/core/contracts";
import { describe, expect, it } from "vitest";

import { formatRows, parseQueryPlansSettings, plannedSizes, targetRows } from "./sizes.ts";
import { MAX_PLANNED_QUERIES, selectPlannableStatements } from "./statements.ts";

describe("sizes", () => {
  it("should plan the run's data, 10k, then the chosen size", () => {
    expect(plannedSizes("seed")).toEqual(["seed"]);
    expect(plannedSizes("10k")).toEqual(["seed", "10k"]);
    expect(plannedSizes("100k")).toEqual(["seed", "10k", "100k"]);
    expect(plannedSizes("1m")).toEqual(["seed", "10k", "1m"]);
  });

  it("should fill leaf tables to the size and each parent level ten times fewer", () => {
    const tables = [
      { key: "users", parents: [] },
      { key: "posts", parents: ["users"] },
      { key: "comments", parents: ["posts", "users"] },
      { key: "tags", parents: [] },
    ];

    expect(Object.fromEntries(targetRows("1m", tables, new Map()))).toEqual({
      users: 10_000,
      posts: 100_000,
      comments: 1_000_000,
      tags: 1_000_000,
    });
    expect(Object.fromEntries(targetRows("1m", tables.slice(0, 2), new Map()))).toEqual({
      users: 100_000,
      posts: 1_000_000,
    });
  });

  it("should never plan fewer rows than a table already holds, nor fewer than ten", () => {
    const tables = [
      { key: "a", parents: [] },
      { key: "b", parents: ["a"] },
      { key: "c", parents: ["b"] },
      { key: "d", parents: ["c"] },
      { key: "e", parents: ["d"] },
    ];
    const targets = targetRows("10k", tables, new Map([["e", 20_000]]));

    expect(targets.get("e")).toBe(20_000);
    expect(targets.get("a")).toBe(10);
  });

  it("should survive a reference cycle and a self reference", () => {
    const tables = [
      { key: "a", parents: ["b", "a"] },
      { key: "b", parents: ["a"] },
    ];
    const targets = targetRows("10k", tables, new Map());

    expect([...targets.values()].every((rows) => rows >= 10)).toBe(true);
  });

  it("should check settings from the submission", () => {
    expect(parseQueryPlansSettings({ size: "100k", measureRealTime: true })).toEqual({
      size: "100k",
      measureRealTime: true,
    });
    expect(() => parseQueryPlansSettings({ size: "10m", measureRealTime: false })).toThrow(TypeError);
    expect(() => parseQueryPlansSettings({ size: "10k" })).toThrow(TypeError);
    expect(() => parseQueryPlansSettings({ size: "10k", measureRealTime: false, extra: 1 })).toThrow(TypeError);
  });

  it("should format row counts the way the board writes them", () => {
    const formatted = [1_000_000, 100_000, 12_500, 2_500, 999].map(formatRows);

    expect(formatted).toEqual(["1M", "100k", "13k", "2.5k", "999"]);
  });
});

const makeSqlEvent = (sequence: number, sql: string, extra: Record<string, unknown> = {}) => ({
  sequence,
  phase: "run" as const,
  kind: "executed" as const,
  outcome: "succeeded" as const,
  sql,
  parameters: [serializeValue(1)],
  ...extra,
});

describe("selectPlannableStatements", () => {
  it("should preserve and distinguish named bindings when selecting queries", () => {
    const selection = selectPlannableStatements([
      {
        ...makeSqlEvent(1, "select :a, :b"),
        parameters: [],
        namedParameters: { b: serializeValue(2), a: serializeValue(1) },
      },
      {
        ...makeSqlEvent(2, "select :a, :b"),
        parameters: [],
        namedParameters: { b: serializeValue(1), a: serializeValue(2) },
      },
    ]);

    expect(selection.statements).toHaveLength(2);
    expect(selection.statements[0].namedValues).toEqual({ b: 2, a: 1 });
  });

  it("should plan only successful run-phase reads and writes, never setup, seed, or transaction control", () => {
    const selection = selectPlannableStatements([
      makeSqlEvent(1, "create table a (id int)", { phase: "bootstrap" }),
      makeSqlEvent(2, "insert into a values ($1)", { phase: "seed" }),
      makeSqlEvent(3, "begin"),
      makeSqlEvent(4, "select * from a where id = $1"),
      makeSqlEvent(5, "select * from b", { outcome: "failed" }),
      makeSqlEvent(6, "  WITH x AS (select 1) select * from x"),
      makeSqlEvent(7, "set search_path to public"),
      makeSqlEvent(8, "update a set id = $1"),
    ]);

    expect(selection.statements.map((statement) => statement.sequences)).toEqual([[4], [6], [8]]);
    expect(selection.statements[0].values).toEqual([1]);
  });

  it("should plan a repeated query once and keep every sequence it ran at", () => {
    const selection = selectPlannableStatements([
      makeSqlEvent(4, "select * from a where id = $1"),
      makeSqlEvent(9, "select * from a where id = $1"),
    ]);

    expect(selection.statements).toHaveLength(1);
    expect(selection.statements[0].sequences).toEqual([4, 9]);
  });

  it("should skip queries whose parameters cannot be sent again, and those past the limit", () => {
    const unsendable = selectPlannableStatements([
      makeSqlEvent(4, "select $1", { parameters: [serializeValue(() => 1)] }),
    ]);

    expect(unsendable.statements).toEqual([]);
    expect(unsendable.skipped).toEqual([
      { sequences: [4], reason: "Its parameters cannot be sent to the database again." },
    ]);

    const many = selectPlannableStatements(
      Array.from({ length: MAX_PLANNED_QUERIES + 2 }, (_, index) => makeSqlEvent(index + 1, `select ${index}`)),
    );

    expect(many.statements).toHaveLength(MAX_PLANNED_QUERIES);
    expect(many.skipped.map((entry) => entry.sequences)).toEqual([
      [MAX_PLANNED_QUERIES + 1],
      [MAX_PLANNED_QUERIES + 2],
    ]);
  });
});
