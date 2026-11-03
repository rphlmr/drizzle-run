import type { PlannedQuery, QueryPlanSize, RawQueryPlan } from "@drizzle-run/core/contracts";

import { postgresSteps, postgresTotalCost } from "./postgres-reading.ts";
import { sqliteSteps } from "./sqlite-reading.ts";

/** One line of a plan as the database printed it, for the plan steps view. */
export interface PlanStep {
  depth: number;
  /** The node or plan line, such as "Seq Scan posts" or "SEARCH posts USING INDEX posts_author_idx (author_id=?)". */
  label: string;
  /**
   * The label split for display: the operation ("Seq Scan", "SEARCH"), then the table it reads and the index it
   * uses.
   */
  operation: string;
  relation?: string;
  index?: string;
  /** Its condition, sort key, or group key, as Postgres wrote it; for SQLite, the rest of the plan line. */
  detail?: string;
  /** Postgres estimates: rows out of this step, cumulative cost, and this step's own share of the total. */
  rows?: number;
  cost?: number;
  shareOfCost?: number;
  /** From `EXPLAIN ANALYZE`, when Measure real time ran. */
  actualRows?: number;
  actualMs?: number;
}

/** The steps of a raw plan, read without changing what the database said. */
export function planSteps(raw: RawQueryPlan): PlanStep[] {
  return raw.database === "postgresql" ? postgresSteps(raw.json) : sqliteSteps(raw.rows);
}

/** How a query grows: Postgres total cost or SQLite median time at each planned size. */
export function planGrowth(
  query: Pick<PlannedQuery, "raw">,
): { size: QueryPlanSize; unit: "cost" | "ms"; value: number | undefined }[] {
  return query.raw.map((raw) =>
    raw.database === "postgresql"
      ? { size: raw.size, unit: "cost", value: postgresTotalCost(raw.json) }
      : { size: raw.size, unit: "ms", value: "medianMs" in raw.timing ? raw.timing.medianMs : undefined },
  );
}
