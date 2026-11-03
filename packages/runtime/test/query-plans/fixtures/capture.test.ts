import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { planQueries } from "../../../src/query-plans/planner.ts";
import { createPostgresAdapter } from "../../../src/query-plans/postgres-adapter.ts";
import { createSqliteAdapter } from "../../../src/query-plans/sqlite-adapter.ts";
import { createTestDatabaseEngine as createDatabaseEngine } from "../../database/engine-fixture.ts";
import { BLOG_KEYS, BLOG_SCHEMA, blogEvents } from "./blog.ts";

/**
 * Regenerates the real EXPLAIN output the reading tests use: `pnpm --filter @drizzle-run/runtime capture:query-plans`.
 *
 * The script sets CAPTURE_QUERY_PLAN_FIXTURES=1 and calls vitest directly, never through Turborepo, so a capture is
 * never replayed from its cache. Turborepo's strict environment mode drops the variable from `test`, so `pnpm test`
 * always skips this suite.
 */
describe.runIf(process.env.CAPTURE_QUERY_PLAN_FIXTURES === "1")("query plan fixtures", () => {
  for (const dialect of ["postgresql", "sqlite"] as const) {
    it(`should capture ${dialect} plans at 1M rows`, async () => {
      const engine = await createDatabaseEngine(dialect);

      try {
        for (const sql of BLOG_SCHEMA[dialect]) {
          await engine.call("plan.exec", { sql });
        }

        const report = await planQueries({
          database: engine,
          dialect,
          settings: { size: "1m", measureRealTime: dialect === "postgresql" },
          events: blogEvents(dialect),
          keys: BLOG_KEYS,
        });

        // A failed plan must not become a fixture.
        expect(report.error).toBeUndefined();

        // The filled tables stay after planning, so their description and counts match the last plans.
        const adapter = dialect === "postgresql" ? createPostgresAdapter(engine) : createSqliteAdapter(engine);
        const tables = await adapter.introspect();
        const tableRows: Record<string, number> = {};

        for (const table of tables) {
          tableRows[table.name] = await adapter.countRows(table);
        }

        const fixture = {
          tables: tables.map(({ name, schema, columns, indexes, foreignKeys }) => ({
            name,
            ...(schema === undefined ? {} : { schema }),
            columns,
            indexes,
            foreignKeys,
            keys: BLOG_KEYS.find((entry) => entry.name === name)?.columns,
          })),
          tableRows,
          report,
        };

        writeFileSync(new URL(`./${dialect}.json`, import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`);
      } finally {
        await engine.close();
      }
    }, 120_000);
  }
});
