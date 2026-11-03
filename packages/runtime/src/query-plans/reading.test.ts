import type { Dialect } from "@drizzle-run/core/catalog";
import type { PostgresRawPlan, RawQueryPlan, SqliteRawPlan } from "@drizzle-run/core/contracts";
import { describe, expect, it } from "vitest";

import { BLOG_QUERIES, type BlogQueryId } from "../../test/query-plans/fixtures/blog.ts";
import { loadFixture } from "../../test/query-plans/fixtures/load.ts";
import { postgresUsesIndex, readPostgresPlan } from "./postgres-reading.ts";
import { confirmsIndex } from "./rules.ts";
import { readSqlitePlan, sqliteUsesIndex } from "./sqlite-reading.ts";
import { planGrowth, planSteps } from "./steps.ts";

const postgres = loadFixture("postgresql");
const sqlite = loadFixture("sqlite");

function sqlOf(dialect: Dialect, id: BlogQueryId): string {
  const query = BLOG_QUERIES.find((entry) => entry.id === id);

  if (query === undefined) {
    throw new Error(`Unknown query ${id}`);
  }

  return query.sql(dialect === "postgresql" ? (position) => `$${position}` : () => "?");
}

function readPostgres(id: BlogQueryId, size: RawQueryPlan["size"] = "1m") {
  const raw = postgres.raw(id, size) as PostgresRawPlan;
  return readPostgresPlan({
    json: raw.json,
    ...(raw.analyze !== undefined && "json" in raw.analyze ? { analyzeJson: raw.analyze.json } : {}),
    sql: sqlOf("postgresql", id),
    tables: postgres.tables,
    tableRows: postgres.tableRows,
  });
}

function readSqlite(id: BlogQueryId, size: RawQueryPlan["size"] = "1m") {
  return readSqlitePlan({
    rows: (sqlite.raw(id, size) as SqliteRawPlan).rows,
    sql: sqlOf("sqlite", id),
    tables: sqlite.tables,
    tableRows: sqlite.tableRows,
  });
}

const candidates = (reading: ReturnType<typeof readPostgres>) =>
  reading.candidates.map((candidate) => `${candidate.trigger}:${candidate.table.name}(${candidate.columns.join(",")})`);

describe("Postgres reading of real EXPLAIN output", () => {
  it("should read a filtered full scan on an unindexed foreign key", () => {
    const reading = readPostgres("posts-by-author");

    expect(reading.summary).toBe("Full scan of posts, reads 100k rows to return 33 rows");
    expect(reading.verdict).toEqual({ kind: "grows", tables: ["posts"] });
    expect(candidates(reading)).toEqual(["filtered_scan:posts(author_id)"]);
  });

  it("should read the largest size, where an index lookup replaces the seed's scan", () => {
    for (const size of ["seed", "10k"] as const) {
      expect(readPostgres("user-by-email", size).verdict).toEqual({ kind: "grows", tables: ["users"] });
    }

    expect(readPostgres("user-by-email", "1m").verdict).toEqual({ kind: "stays_fast" });

    expect(postgres.query("user-by-email").reading?.verdict).toEqual({ kind: "stays_fast" });

    expect(readPostgres("user-by-email").summary).toBe("Index lookup on users using users_email_key to return 1 row");
    expect(readPostgres("user-by-email").candidates).toEqual([]);
  });

  it("should ask for an index when order by and limit sort the whole table", () => {
    const reading = readPostgres("latest-posts");

    expect(reading.summary).toContain("sorts every row");
    expect(candidates(reading)).toEqual(["sorted_limit:posts(created_at)"]);
  });

  it("should never suggest an index for queries that must read whole tables", () => {
    for (const id of ["count-posts", "posts-per-user"] as const) {
      const reading = readPostgres(id);

      expect(reading.verdict.kind).toBe("grows");
      expect(reading.candidates).toEqual([]);
    }
  });

  it("should ask for an index on a table a subquery scans once per outer row, as the relational API's with does", () => {
    const sql = `select "d0"."name", "posts"."r" from "users" as "d0" left join lateral (select json_agg("d1"."title") as "r" from "posts" as "d1" where "d0"."id" = "d1"."author_id") as "posts" on true order by "d0"."id"`;
    const json = JSON.stringify([
      {
        Plan: {
          "Node Type": "Nested Loop",
          "Join Type": "Left",
          "Total Cost": 17_913_963,
          "Plan Rows": 10_000,
          Plans: [
            {
              "Node Type": "Index Scan",
              "Relation Name": "users",
              Alias: "d0",
              "Index Name": "users_pkey",
              "Total Cost": 443,
              "Plan Rows": 10_000,
            },
            {
              "Node Type": "Aggregate",
              "Total Cost": 1_791,
              "Plan Rows": 1,
              Plans: [
                {
                  "Node Type": "Seq Scan",
                  "Relation Name": "posts",
                  Alias: "d1",
                  Filter: "(d0.id = author_id)",
                  "Total Cost": 1_790,
                  "Plan Rows": 10,
                },
              ],
            },
          ],
        },
      },
    ]);

    const reading = readPostgresPlan({ json, sql, tables: postgres.tables, tableRows: postgres.tableRows });

    expect(candidates(reading)).toEqual(["filtered_scan:posts(author_id)"]);
  });

  it("should find the filtered scan inside a join", () => {
    expect(candidates(readPostgres("comments-by-author"))).toContain("filtered_scan:comments(author_id)");
  });

  it("should read writes and an unfiltered limit as staying fast", () => {
    expect(readPostgres("insert-post")).toMatchObject({
      summary: "Inserts into posts",
      verdict: { kind: "stays_fast" },
      candidates: [],
    });
    expect(readPostgres("rename-user").verdict).toEqual({ kind: "stays_fast" });
    expect(readPostgres("first-posts")).toMatchObject({
      summary: "Reads the first rows of posts and stops to return 5 rows",
      verdict: { kind: "stays_fast" },
    });
  });

  it("should call a full scan a growing query even on the seed data", () => {
    expect(readPostgres("posts-by-author", "seed").verdict).toEqual({ kind: "grows", tables: ["posts"] });
  });

  it("should keep the raw plan with real time at the chosen size only", () => {
    expect(postgres.raw("posts-by-author", "seed")).not.toHaveProperty("analyze");
    expect(postgres.raw("posts-by-author", "10k")).not.toHaveProperty("analyze");
    const chosen = postgres.raw("posts-by-author", "1m") as PostgresRawPlan;

    expect(chosen.text).toMatch(/^Seq Scan on posts {2}\(cost=/);
    expect(chosen.analyze !== undefined && "text" in chosen.analyze ? chosen.analyze.text : "").toContain(
      "Rows Removed by Filter",
    );
  });
});

describe("SQLite reading of real EXPLAIN QUERY PLAN output", () => {
  it("should read a filtered full scan on an unindexed foreign key", () => {
    const reading = readSqlite("posts-by-author");

    expect(reading.summary).toBe("Full scan of posts, reads 100k rows");
    expect(reading.verdict).toEqual({ kind: "grows", tables: ["posts"] });
    expect(candidates(reading)).toEqual(["filtered_scan:posts(author_id)"]);
  });

  it("should keep an index search fast", () => {
    expect(readSqlite("user-by-email")).toMatchObject({
      summary: "Index search on users using users_email_unique",
      verdict: { kind: "stays_fast" },
      candidates: [],
    });
  });

  it("should ask for an index when order by and limit sort the whole table", () => {
    expect(candidates(readSqlite("latest-posts"))).toEqual(["sorted_limit:posts(created_at)"]);
  });

  it("should read an automatic index as growing, without a suggestion for a whole-table join", () => {
    const reading = readSqlite("posts-per-user");

    expect(reading.summary).toBe("Scans users, builds a temporary index on posts each call");
    expect(reading.verdict).toEqual({ kind: "grows", tables: ["users", "posts"] });
    expect(reading.candidates).toEqual([]);
  });

  it("should ignore the foreign key check SQLite lists for an insert into a parent table", () => {
    expect((sqlite.raw("insert-post", "1m") as SqliteRawPlan).rows.map((row) => row.detail)).toEqual(["SCAN comments"]);
    expect(readSqlite("insert-post")).toMatchObject({
      summary: "Inserts without reading a table first",
      verdict: { kind: "stays_fast" },
    });
  });

  it("should read an unfiltered limit as stopping after the first rows", () => {
    expect(readSqlite("first-posts")).toMatchObject({
      summary: "Reads the first rows of posts and stops",
      verdict: { kind: "stays_fast" },
    });
  });

  it("should time every size with several samples", () => {
    for (const raw of sqlite.query("posts-by-author").raw) {
      expect(raw.database === "sqlite" && "samples" in raw.timing ? raw.timing.samples : 0).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("confirmed indexes in the captured runs", () => {
  for (const [dialect, fixture, usesIndex] of [
    [
      "postgresql",
      postgres,
      (raw: RawQueryPlan, name: string) => raw.database === "postgresql" && postgresUsesIndex(raw.json, name),
    ],
    [
      "sqlite",
      sqlite,
      (raw: RawQueryPlan, name: string) => raw.database === "sqlite" && sqliteUsesIndex(raw.rows, name),
    ],
  ] as const) {
    it(`${dialect}: should keep only indexes the database used and that pass the tenfold rule`, () => {
      const confirmed = fixture.report.queries.flatMap((query) => query.reading?.indexes ?? []);

      expect(confirmed.map((index) => index.drizzle)).toEqual([
        `index("posts_author_idx").on(t.authorId)`,
        `index("posts_created_at_idx").on(t.createdAt)`,
        `index("comments_author_idx").on(t.authorId)`,
      ]);

      for (const index of confirmed) {
        expect(usesIndex(index.before, index.name)).toBe(false);
        expect(usesIndex(index.after, index.name)).toBe(true);
        expect(index.measure.after * 10).toBeLessThanOrEqual(index.measure.before);
        expect(confirmsIndex({ used: true, ...index.measure })).toBe(true);
      }
    });
  }
});

describe("plan steps and growth", () => {
  it("should list Postgres nodes with their share of the cost", () => {
    const steps = planSteps(postgres.raw("latest-posts", "1m"));

    expect(steps[0]).toMatchObject({ depth: 0, label: expect.stringContaining("Limit") });
    expect(steps.some((step) => step.label.includes("Sort"))).toBe(true);
    expect(
      steps.every((step) => step.shareOfCost === undefined || (step.shareOfCost >= 0 && step.shareOfCost <= 1)),
    ).toBe(true);
  });

  it("should split each step into its operation and the table it reads", () => {
    const postgresScan = planSteps(postgres.raw("posts-by-author", "1m")).find((step) => step.relation === "posts");
    const sqliteSteps = planSteps(sqlite.raw("posts-by-author", "1m"));

    expect(postgresScan).toMatchObject({ operation: "Seq Scan", label: "Seq Scan posts" });
    expect(sqliteSteps[0]).toMatchObject({ operation: "SCAN", relation: "posts" });
    expect(sqliteSteps.every((step) => step.label.startsWith(step.operation))).toBe(true);
  });

  it("should nest SQLite rows by parent", () => {
    expect(planSteps(sqlite.raw("comments-by-author", "1m")).map((step) => step.depth)).toEqual([0, 0]);
  });

  it("should show growth by size: Postgres cost and SQLite time", () => {
    const cost = planGrowth(postgres.query("posts-by-author"));
    const time = planGrowth(sqlite.query("posts-by-author"));

    expect(cost.map((point) => point.size)).toEqual(["seed", "10k", "1m"]);
    expect(cost[2].value).toBeGreaterThan(cost[1].value ?? Infinity);
    expect(time.every((point) => point.unit === "ms" && typeof point.value === "number")).toBe(true);
  });
});
