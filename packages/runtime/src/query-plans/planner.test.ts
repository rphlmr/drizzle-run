import type { Dialect } from "@drizzle-run/core/catalog";
import { serializeValue } from "@drizzle-run/core/contracts";
import { describe, expect, it } from "vitest";

import { createTestDatabaseEngine as createDatabaseEngine } from "../../test/database/engine-fixture.ts";
import { BLOG_KEYS, BLOG_QUERIES, BLOG_SCHEMA, blogEvents } from "../../test/query-plans/fixtures/blog.ts";
import type { DatabaseEngine } from "../database/database-engine.ts";
import { planQueries } from "./planner.ts";
import { MAX_TIMED_COST } from "./postgres-adapter.ts";
import { postgresTotalCost } from "./postgres-reading.ts";

async function createBlogDatabase(dialect: Dialect): Promise<DatabaseEngine> {
  const engine = await createDatabaseEngine(dialect);

  for (const sql of BLOG_SCHEMA[dialect]) {
    await engine.call("plan.exec", { sql });
  }

  return engine;
}

async function queryRows(engine: DatabaseEngine, dialect: Dialect, sql: string): Promise<Record<string, unknown>[]> {
  const request = dialect === "postgresql" ? { sql, params: [] } : { statement: sql };
  const result = (await engine.call("plan.query", request)) as { rows: Record<string, unknown>[] };

  return result.rows;
}

describe.each(["postgresql", "sqlite"] as const)("planQueries on %s", (dialect) => {
  it.runIf(dialect === "sqlite")("should replay named bindings without changing their positions", async () => {
    const engine = await createDatabaseEngine("sqlite");
    const call = engine.call.bind(engine);
    const requests: unknown[] = [];
    engine.call = (operation, value) => {
      if (operation === "plan.query") {
        requests.push(value);
      }

      return call(operation, value);
    };

    try {
      const namedParameters = { b: serializeValue(2), a: serializeValue(1) };
      const report = await planQueries({
        database: engine,
        dialect: "sqlite",
        settings: { size: "seed", measureRealTime: true },
        events: [
          {
            sequence: 1,
            phase: "run",
            kind: "executed",
            outcome: "succeeded",
            sql: "select :a as first, :b as second",
            parameters: [],
            namedParameters,
          },
        ],
      });

      expect(report.error).toBeUndefined();
      expect(report.queries[0]).toMatchObject({ namedParameters });
      expect(requests).toContainEqual({
        statement: { sql: "EXPLAIN QUERY PLAN select :a as first, :b as second", args: { b: 2, a: 1 } },
      });
    } finally {
      await engine.close();
    }
  });

  it("should fill the run's tables, plans every run query, and leaves the run's own data", async () => {
    const engine = await createBlogDatabase(dialect);

    try {
      const report = await planQueries({
        database: engine,
        dialect,
        settings: { size: "10k", measureRealTime: true },
        events: [
          {
            sequence: 1,
            phase: "seed",
            kind: "executed",
            outcome: "succeeded",
            sql: `insert into "users" ("name") values ('seeded')`,
            parameters: [],
          },
          ...blogEvents(dialect),
        ],
        keys: BLOG_KEYS,
      });

      expect(report.error).toBeUndefined();
      expect(report.dialect).toBe(dialect);
      expect(report.fills.map((fill) => fill.size)).toEqual(["seed", "10k"]);
      expect(Object.fromEntries(report.fills[1].tables.map((table) => [table.name, table.rows]))).toEqual({
        users: 100,
        posts: 1_000,
        comments: 10_000,
      });
      expect(report.queries.map((query) => query.sql)).toEqual(blogEvents(dialect).map((event) => event.sql));

      for (const query of report.queries) {
        expect(query.error).toBeUndefined();
        expect(query.raw.map((raw) => raw.size)).toEqual(["seed", "10k"]);
        expect(query.reading?.summary).toEqual(expect.any(String));
      }

      const insert = report.queries[BLOG_QUERIES.findIndex((query) => query.id === "insert-post")];
      const chosen = insert.raw[1];

      const analyzedText =
        chosen.database === "postgresql" && chosen.analyze !== undefined && "text" in chosen.analyze
          ? chosen.analyze.text
          : undefined;
      const samples = chosen.database === "sqlite" && "medianMs" in chosen.timing ? chosen.timing.samples : undefined;

      const expectedInsertMeasure = {
        postgresql: { analyzedText: expect.stringMatching(/^Insert on posts/), samples: undefined },
        sqlite: { analyzedText: undefined, samples: expect.toSatisfy((count: number) => count >= 3) },
      };

      expect({ analyzedText, samples }).toEqual(expectedInsertMeasure[dialect]);

      const count = dialect === "postgresql" ? "count(*)::int" : "count(*)";

      expect(
        await queryRows(engine, dialect, `select ${count} as "count" from "posts" where "title" = 'Planned'`),
      ).toEqual([{ count: 0 }]);
      expect(await queryRows(engine, dialect, `select "name" from "users" where "id" = 1`)).toEqual([{ name: "Ada" }]);

      const indexes =
        dialect === "postgresql"
          ? await queryRows(
              engine,
              dialect,
              `select indexname as "name" from pg_indexes where schemaname = 'public' order by 1`,
            )
          : await queryRows(
              engine,
              dialect,
              `select name from sqlite_schema where type = 'index' and name not like 'sqlite_autoindex%' order by 1`,
            );
      const leftovers =
        dialect === "postgresql"
          ? await queryRows(engine, dialect, `select relname from pg_class where relname like 'drizzle_run%'`)
          : await queryRows(engine, dialect, `select name from sqlite_temp_schema where name like 'drizzle_run%'`);

      expect(indexes.map((index) => index.name)).toEqual(
        dialect === "postgresql"
          ? ["comments_pkey", "posts_pkey", "users_email_key", "users_pkey"]
          : ["users_email_unique"],
      );
      expect(leftovers).toEqual([]);
    } finally {
      await engine.close();
    }
  }, 60_000);

  it("should keep the plans made so far when planning runs out of time", async () => {
    const engine = await createBlogDatabase(dialect);

    try {
      const report = await planQueries({
        database: engine,
        dialect,
        settings: { size: "1m", measureRealTime: false },
        events: blogEvents(dialect),
        budgetMs: 0,
      });

      expect(report.error?.message).toMatch(/ran out of time/);
      expect(report.fills).toEqual([]);
    } finally {
      await engine.close();
    }
  });

  it("should plan nothing and fill nothing when the run sent no queries", async () => {
    const engine = await createBlogDatabase(dialect);

    try {
      const report = await planQueries({
        database: engine,
        dialect,
        settings: { size: "1m", measureRealTime: false },
        events: [
          {
            sequence: 1,
            phase: "run",
            kind: "executed",
            outcome: "succeeded",
            sql: "begin",
            parameters: [serializeValue(1)],
          },
        ],
      });

      expect(report).toMatchObject({ fills: [], queries: [], skipped: [] });
      expect(report.error).toBeUndefined();
    } finally {
      await engine.close();
    }
  });
});

/** A run query with no fast plan: every comment paired with every comment of every post. */
function makeCostlyEvent() {
  return {
    sequence: 1,
    phase: "run",
    kind: "executed",
    outcome: "succeeded",
    sql: `select count(*) from "comments" as "a", "comments" as "b", "posts" as "c" where "a"."body" <> "b"."body"`,
    parameters: [],
  } as const;
}

describe("planQueries real time on postgresql", () => {
  it("should plan a query Postgres estimates too costly to time, without timing it", async () => {
    const engine = await createBlogDatabase("postgresql");

    try {
      const report = await planQueries({
        database: engine,
        dialect: "postgresql",
        settings: { size: "10k", measureRealTime: true },
        events: [makeCostlyEvent()],
        budgetMs: 30_000,
      });
      const [costly] = report.queries;
      const chosen = costly.raw.at(-1);

      expect(report.error).toBeUndefined();
      expect(costly.error).toBeUndefined();
      expect(costly.reading?.summary).toEqual(expect.any(String));
      expect(chosen?.database === "postgresql" && postgresTotalCost(chosen.json)).toBeGreaterThan(MAX_TIMED_COST);
      expect(chosen?.database === "postgresql" ? chosen.analyze : undefined).toEqual({
        error: expect.objectContaining({ message: expect.stringMatching(/^Not timed: Postgres estimates/) }),
      });
    } finally {
      await engine.close();
    }
  }, 60_000);

  it("should stop waiting on a timed statement that outlasts the budget and keep the run's report", async () => {
    const engine = await createBlogDatabase("postgresql");
    const inFlight: Promise<unknown>[] = [];
    const database = {
      call: (operation: string, value: unknown) => {
        if (JSON.stringify(value).includes("EXPLAIN (ANALYZE")) {
          return new Promise<never>(() => undefined);
        }

        const call = engine.call(operation, value);
        inFlight.push(call.catch(() => undefined));

        return call;
      },
    };

    try {
      const startedAtMs = performance.now();
      const report = await planQueries({
        database,
        dialect: "postgresql",
        settings: { size: "seed", measureRealTime: true },
        events: blogEvents("postgresql"),
        budgetMs: 2_000,
      });

      expect(performance.now() - startedAtMs).toBeLessThan(10_000);
      expect(report.error?.message).toMatch(/ran out of time/);
      expect(report.queries[0].error).toBeUndefined();
      expect(report.queries[0].raw).toEqual([]);
    } finally {
      await Promise.all(inFlight);
      await engine.close();
    }
  }, 30_000);

  it("should keep a query's reading from the smaller sizes when planning stops while it is timed", async () => {
    const engine = await createBlogDatabase("postgresql");
    const planning = new AbortController();
    const inFlight: Promise<unknown>[] = [];
    const database = {
      call: (operation: string, value: unknown) => {
        if (JSON.stringify(value).includes("EXPLAIN (ANALYZE")) {
          planning.abort();

          return new Promise<never>(() => undefined);
        }

        const call = engine.call(operation, value);
        inFlight.push(call.catch(() => undefined));

        return call;
      },
    };

    try {
      const report = await planQueries({
        database,
        dialect: "postgresql",
        settings: { size: "10k", measureRealTime: true },
        events: blogEvents("postgresql"),
        signal: planning.signal,
        budgetMs: 30_000,
      });
      const [first] = report.queries;

      expect(report.error?.message).toBe("Planning was cancelled");
      expect(first.error).toBeUndefined();
      expect(first.raw).toHaveLength(1);
      expect(first.reading?.summary).toEqual(expect.any(String));
    } finally {
      await Promise.all(inFlight);
      await engine.close();
    }
  }, 60_000);
});
