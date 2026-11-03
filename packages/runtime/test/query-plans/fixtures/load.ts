import { readFileSync } from "node:fs";

import type { Dialect } from "@drizzle-run/core/catalog";
import type { PlannedQuery, QueryPlansReport, RawQueryPlan } from "@drizzle-run/core/contracts";

import type { PlanTable } from "../../../src/query-plans/schema.ts";
import { BLOG_QUERIES, type BlogQueryId } from "./blog.ts";

interface Fixture {
  tables: PlanTable[];
  tableRows: Record<string, number>;
  report: QueryPlansReport;
}

/** Real planner output captured by `capture.test.ts`: the blog schema filled to 1M rows. */
export function loadFixture(dialect: Dialect) {
  const fixture = JSON.parse(readFileSync(new URL(`./${dialect}.json`, import.meta.url), "utf8")) as Fixture;
  const tableRows = new Map(fixture.tables.map((table) => [table, fixture.tableRows[table.name] ?? 0]));
  const query = (id: BlogQueryId): PlannedQuery => {
    const found = fixture.report.queries[BLOG_QUERIES.findIndex((entry) => entry.id === id)];

    if (found === undefined) {
      throw new Error(`The ${dialect} fixture has no ${id} query`);
    }

    return found;
  };

  const raw = (id: BlogQueryId, size: RawQueryPlan["size"]): RawQueryPlan => {
    const found = query(id).raw.find((entry) => entry.size === size);

    if (found === undefined) {
      throw new Error(`The ${dialect} fixture has no ${size} plan for ${id}`);
    }

    return found;
  };

  return { tables: fixture.tables, tableRows, report: fixture.report, query, raw };
}
