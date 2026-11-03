import { QUERY_PLAN_SIZES, type QueryPlanSize, type QueryPlansSettings } from "@drizzle-run/core/contracts";
import * as z from "zod/mini";

import { plainRecord, refined } from "../schema.ts";

/** Rows in the largest table at each size; `seed` keeps the run's own rows. */
export const QUERY_PLAN_SIZE_ROWS: Readonly<Record<Exclude<QueryPlanSize, "seed">, number>> = {
  "10k": 10_000,
  "100k": 100_000,
  "1m": 1_000_000,
};

/** Each table referenced by another gets ten times fewer rows than its largest child: 1M posts, 100k users. */
export const FAN_OUT = 10;

const MIN_FILLED_ROWS = 10;

/** Check that an untrusted value is one of the query plan sizes. */
export function isQueryPlanSize(value: unknown): value is QueryPlanSize {
  return QUERY_PLAN_SIZES.some((size) => size === value);
}

export const QueryPlansSettingsSchema = z.pipe(
  plainRecord("Query plans settings must be an object"),
  z.strictObject(
    {
      size: refined(isQueryPlanSize, "Invalid query plans settings"),
      measureRealTime: z.boolean({ error: "Invalid query plans settings" }),
    },
    {
      error: (issue) => (issue.code === "unrecognized_keys" ? "Query plans settings have unknown fields" : undefined),
    },
  ),
) satisfies z.ZodMiniType<QueryPlansSettings>;

/** Parse untrusted query plans settings; throws a `TypeError` on a non-object, unknown fields, or invalid values. */
export function parseQueryPlansSettings(input: unknown): QueryPlansSettings {
  const settings = QueryPlansSettingsSchema.safeParse(input);

  if (!settings.success) {
    throw new TypeError(settings.error.issues[0]?.message ?? "Invalid query plans settings");
  }

  return settings.data;
}

/** The sizes a run is planned at: its own data, 10k, then the chosen size. */
export function plannedSizes(size: QueryPlanSize): QueryPlanSize[] {
  if (size === "seed") {
    return ["seed"];
  }

  return size === "10k" ? ["seed", "10k"] : ["seed", "10k", size];
}

/** A table in the fill graph, keyed so tables with the same name in different schemas stay apart */
export interface FillGraphTable {
  key: string;
  /** Keys of the tables this one references. */
  parents: readonly string[];
}

/**
 * Target rows per table for one size: tables nobody references hold the full size, and each level of
 * parents holds ten times fewer, never fewer than the rows already there.
 */
export function targetRows(
  size: Exclude<QueryPlanSize, "seed">,
  tables: readonly FillGraphTable[],
  existing: ReadonlyMap<string, number>,
): Map<string, number> {
  const children = new Map<string, Set<string>>();

  for (const table of tables) {
    for (const parent of table.parents) {
      if (parent !== table.key) {
        children.set(parent, (children.get(parent) ?? new Set()).add(table.key));
      }
    }
  }

  const depths = new Map<string, number>();
  const getDepth = (key: string, visiting: Set<string>): number => {
    const known = depths.get(key);

    if (known !== undefined) {
      return known;
    }

    if (visiting.has(key)) {
      return 0;
    }

    visiting.add(key);
    let maxDepth = 0;

    for (const child of children.get(key) ?? []) {
      maxDepth = Math.max(maxDepth, getDepth(child, visiting) + 1);
    }

    visiting.delete(key);
    depths.set(key, maxDepth);

    return maxDepth;
  };

  const sizeRows = QUERY_PLAN_SIZE_ROWS[size];
  const targets = new Map<string, number>();

  for (const table of tables) {
    const target = Math.max(MIN_FILLED_ROWS, Math.floor(sizeRows / FAN_OUT ** getDepth(table.key, new Set())));
    targets.set(table.key, Math.max(target, existing.get(table.key) ?? 0));
  }

  return targets;
}

/** "1M", "100k", "10k", or the plain count below a thousand. */
export function formatRows(rows: number): string {
  if (rows >= 1_000_000) {
    return `${trimNumber(rows / 1_000_000)}M`;
  }

  if (rows >= 1_000) {
    return `${trimNumber(rows / 1_000)}k`;
  }

  return String(Math.round(rows));
}

function trimNumber(value: number): string {
  return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}
