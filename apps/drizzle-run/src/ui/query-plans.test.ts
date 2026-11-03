import type {
  ConfirmedIndex,
  PlannedQuery,
  PostgresRawPlan,
  QueryPlansReport,
  RawQueryPlan,
  SqliteRawPlan,
} from "@drizzle-run/core/contracts";
import { describe, expect, it } from "vitest";

import {
  describeIndexTarget,
  formatCost,
  formatPlanTime,
  getChosenSteps,
  getExplainText,
  getGrowthRow,
  getIndexBarShare,
  getIndexTrySentence,
  getPlanEntries,
  getPlanNote,
  getPlansChipLabel,
  getPlansHintLabel,
  getPlansTabMark,
  getPlansTabMarkLabel,
  getSqliteIndexLine,
  getVerdictLabel,
  needsPlannedRun,
  QUERY_PLANS_OFF,
  summarizeFill,
  toQueryPlansSettings,
} from "./query-plans";

function makePostgresPlan(size: RawQueryPlan["size"], cost: number): PostgresRawPlan {
  return {
    database: "postgresql",
    size,
    json: JSON.stringify([
      {
        Plan: {
          "Node Type": "Seq Scan",
          "Relation Name": "posts",
          "Total Cost": cost,
          "Plan Rows": 10,
          Filter: "(author_id = $1)",
        },
      },
    ]),
    text: `Seq Scan on posts  (cost=0.00..${cost} rows=10 width=40)`,
  };
}

function makeSqlitePlan(size: SqliteRawPlan["size"], medianMs: number, detail = "SCAN posts"): SqliteRawPlan {
  return {
    database: "sqlite",
    size,
    rows: [{ id: 2, parent: 0, notused: 0, detail }],
    timing: { samples: 30, medianMs, minMs: medianMs, maxMs: medianMs },
  };
}

const grows = { kind: "grows", tables: ["posts"] } as const;

function makePlannedQuery(raw: RawQueryPlan[], indexes: ConfirmedIndex[] = [], sequences = [10]): PlannedQuery {
  return {
    sequences,
    sql: 'select "id" from "posts" where "author_id" = ?',
    parameters: [],
    raw,
    reading: { summary: "Full scan of posts, reads 100k rows", verdict: grows, indexes },
  };
}

function makeReport(
  dialect: QueryPlansReport["dialect"],
  size: QueryPlansReport["settings"]["size"],
  queries: PlannedQuery[],
): QueryPlansReport {
  return {
    settings: { size, measureRealTime: false },
    dialect,
    fills: [
      {
        size: "seed",
        tables: [
          { name: "posts", rows: 3 },
          { name: "users", rows: 3 },
        ],
        durationMs: 0,
      },
      {
        size: "1m",
        tables: [
          { name: "users", rows: 100_000 },
          { name: "posts", rows: 1_000_000 },
        ],
        durationMs: 2900,
      },
    ],
    queries,
    skipped: [{ sequences: [12], reason: "its parameters cannot be sent back to the database" }],
    durationMs: 4700,
  };
}

const sqliteIndex: ConfirmedIndex = {
  trigger: "filtered_scan",
  table: "posts",
  columns: ["author_id"],
  name: "posts_author_idx",
  drizzle: 'index("posts_author_idx").on(t.authorId)',
  measure: { unit: "ms", before: 59, after: 0.27 },
  before: makeSqlitePlan("1m", 59),
  after: makeSqlitePlan("1m", 0.27, "SEARCH posts USING INDEX posts_author_idx (author_id=?)"),
};

describe("Query plans flag", () => {
  it("should submit nothing while off, and the size and Measure real time once on", () => {
    expect(toQueryPlansSettings(QUERY_PLANS_OFF)).toBeUndefined();
    expect(toQueryPlansSettings({ ...QUERY_PLANS_OFF, on: true })).toEqual({ size: "1m", measureRealTime: false });
  });

  it("should ask for a run only when the shown run was not planned with the current settings", () => {
    const on = { size: "1m", measureRealTime: false } as const;

    expect(needsPlannedRun(undefined, undefined)).toBe(false);
    expect(needsPlannedRun(undefined, on)).toBe(false);
    expect(needsPlannedRun(on, undefined)).toBe(true);
    expect(needsPlannedRun(on, on)).toBe(false);
    expect(needsPlannedRun(on, { ...on, size: "10k" })).toBe(true);
    expect(needsPlannedRun(on, { ...on, measureRealTime: true })).toBe(true);
  });

  it("should name the size in the Logs filter row, shorter on phones", () => {
    expect(getPlansHintLabel("1m")).toBe("Plans as if tables held 1M rows");
    expect(getPlansChipLabel("1m")).toBe("Plans at 1M rows");
    expect(getPlansHintLabel("seed")).toBe("Plans at seed data");
  });
});

describe("plan readings", () => {
  it("should word the verdict, never by color alone", () => {
    expect(getVerdictLabel({ kind: "stays_fast" })).toBe("Stays fast");
    expect(getVerdictLabel(grows)).toBe("Grows with posts");
    expect(getVerdictLabel({ kind: "grows", tables: ["users", "posts"] })).toBe("Grows with both");
    expect(getVerdictLabel({ kind: "grows", tables: ["a", "b", "c"] })).toBe("Grows with 3 tables");
  });

  it.each([
    [106380, "106,380"],
    [18870, "18,870"],
    [43, "43"],
    [8.87, "8.87"],
    [1, "1"],
  ])("should format cost %s as %s", (cost, label) => {
    expect(formatCost(cost)).toBe(label);
  });

  it.each([
    [1400, "1.4 s"],
    [59, "59 ms"],
    [2.176, "2.2 ms"],
    [0.27, "0.27 ms"],
    [0.4, "0.4 ms"],
  ])("should format %s ms as %s", (ms, label) => {
    expect(formatPlanTime(ms)).toBe(label);
  });

  it("should map every run-phase statement to its plan, or to why it was skipped", () => {
    const planned = makePlannedQuery([makeSqlitePlan("seed", 0.05)], [], [10, 11]);
    const entries = getPlanEntries(makeReport("sqlite", "1m", [planned]));

    expect(entries.get(10)).toEqual({ kind: "planned", query: planned });
    expect(entries.get(11)).toEqual({ kind: "planned", query: planned });
    expect(entries.get(12)).toEqual({ kind: "skipped", reason: "its parameters cannot be sent back to the database" });
    expect(entries.has(13)).toBe(false);
  });

  it("should read the steps from the largest planned size", () => {
    const steps = getChosenSteps(
      makePlannedQuery([makeSqlitePlan("seed", 0.05, "SCAN users"), makeSqlitePlan("1m", 59, "SCAN posts")]),
    );

    expect(steps).toEqual([expect.objectContaining({ operation: "SCAN", relation: "posts" })]);
  });

  it("should show growth as Postgres total cost or SQLite time, the chosen size last", () => {
    const cost = getGrowthRow(
      makePlannedQuery([makePostgresPlan("seed", 1), makePostgresPlan("10k", 189), makePostgresPlan("1m", 18870)]),
    );
    const time = getGrowthRow(
      makePlannedQuery([makeSqlitePlan("seed", 0.6), makeSqlitePlan("10k", 2), makeSqlitePlan("1m", 59)]),
    );

    expect(cost.label).toBe("Total cost");
    expect(cost.points.map((point) => [point.label, point.value, point.chosen])).toEqual([
      ["seed", "1", false],
      ["10k", "189", false],
      ["1M", "18,870", true],
    ]);
    expect(time.label).toBe("Time");
    expect(time.points.map((point) => point.value)).toEqual(["0.6 ms", "2 ms", "59 ms"]);
  });

  it("should copy the database's raw output, with EXPLAIN ANALYZE when it ran", () => {
    const analyze = { json: "[]", text: "Seq Scan on posts (actual time=0.01..19.8 rows=10 loops=1)" };
    const raw: PostgresRawPlan = { ...makePostgresPlan("1m", 18870), analyze };

    expect(getExplainText(raw)).toBe(`${raw.text}\n\nEXPLAIN ANALYZE\n${analyze.text}`);
    expect(getExplainText(makeSqlitePlan("1m", 59))).toBe("id\tparent\tnotused\tdetail\n2\t0\t0\tSCAN posts");
  });
});

describe("Logs tab mark", () => {
  it("should count the queries that grow, and say so in words", () => {
    const growing = makePlannedQuery([makeSqlitePlan("1m", 59)]);
    const fast = {
      ...growing,
      reading: { summary: "Index lookup", verdict: { kind: "stays_fast" }, indexes: [] },
    } as const;

    const mark = getPlansTabMark(makeReport("sqlite", "1m", [growing, fast, growing]));

    expect(mark).toEqual({ kind: "grows", queries: 2 });
    expect(getPlansTabMarkLabel({ kind: "grows", queries: 1 })).toBe("1 grows");
    expect(getPlansTabMarkLabel({ kind: "grows", queries: 2 })).toBe("2 grow");
  });

  it("should mark a run whose every query stays fast, and nothing when no query was read", () => {
    const growing = makePlannedQuery([makeSqlitePlan("1m", 59)]);
    const fast = {
      ...growing,
      reading: { summary: "Index lookup", verdict: { kind: "stays_fast" }, indexes: [] },
    } as const;
    const unread = { ...growing, reading: undefined };

    expect(getPlansTabMark(makeReport("sqlite", "1m", [fast]))).toEqual({ kind: "stays_fast" });
    expect(getPlansTabMark(makeReport("sqlite", "1m", [unread]))).toBeUndefined();
    expect(getPlansTabMark(makeReport("sqlite", "1m", []))).toBeUndefined();
  });
});

describe("plan notes", () => {
  it("should explain that SQLite times under 1 ms never confirm an index", () => {
    const fast = makePlannedQuery([
      makeSqlitePlan("seed", 0.05),
      makeSqlitePlan("10k", 0.2),
      makeSqlitePlan("1m", 0.6),
    ]);

    expect(getPlanNote(fast, makeReport("sqlite", "1m", [fast]))).toMatch(/under a millisecond/);
  });

  it("should say small fills cannot hold a reading", () => {
    const small = makePlannedQuery([makePostgresPlan("seed", 1), makePostgresPlan("10k", 189)]);

    expect(getPlanNote(small, makeReport("postgresql", "10k", [small]))).toMatch(/Plan at 100k or 1M rows/);
  });

  it("should stay quiet when an index was confirmed or the query stays fast", () => {
    const confirmed = makePlannedQuery([makeSqlitePlan("1m", 59)], [sqliteIndex]);
    const fast: PlannedQuery = {
      ...confirmed,
      reading: { summary: "Index lookup", verdict: { kind: "stays_fast" }, indexes: [] },
    };

    expect(getPlanNote(confirmed, makeReport("sqlite", "1m", [confirmed]))).toBeUndefined();
    expect(getPlanNote(fast, makeReport("sqlite", "1m", [fast]))).toBeUndefined();
  });
});

describe("index tries", () => {
  it("should name the index, the reason and SQLite's own plan line", () => {
    expect(describeIndexTarget(sqliteIndex)).toBe("posts.author_id");
    expect(describeIndexTarget({ table: "posts", columns: ["author_id", "created_at"] })).toBe(
      "posts (author_id, created_at)",
    );
    expect(getIndexTrySentence(sqliteIndex, "postgresql", "schema.ts")).toBe(
      "The filter column has no index in schema.ts, so Drizzle Run added one to the filled tables and asked Postgres to plan again. Postgres would use it.",
    );
    expect(getIndexTrySentence({ trigger: "sorted_limit" }, "sqlite", "schema.ts")).toMatch(
      /^The query sorts the whole table.*timed the query again\. SQLite would use it$/,
    );
    expect(getSqliteIndexLine(sqliteIndex)).toBe("SEARCH posts USING INDEX posts_author_idx (author_id=?)");
  });

  it("should draw the With index bar as a share of Now", () => {
    expect(getIndexBarShare({ unit: "cost", before: 18870, after: 43 })).toBeCloseTo(0.0023, 4);
    expect(getIndexBarShare({ unit: "ms", before: 0, after: 0 })).toBe(0);
  });

  it("should describe the fill of the chosen size, largest table first", () => {
    const planned = makeReport("postgresql", "1m", []);

    expect(summarizeFill(planned)).toBe("tables filled to 1M posts, 100k users");
    expect(summarizeFill({ ...planned, settings: { size: "seed", measureRealTime: false } })).toBe(
      "tables kept at seed data",
    );
  });
});
