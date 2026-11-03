import type { Dialect } from "@drizzle-run/core/catalog";
import type {
  ConfirmedIndex,
  PlannedQuery,
  QueryPlanFill,
  QueryPlanReading,
  QueryPlansReport,
  QueryPlansSettings,
  RawQueryPlan,
  SqlEvent,
} from "@drizzle-run/core/contracts";
import { serializeError } from "@drizzle-run/core/contracts";
import { escapeRegExp } from "es-toolkit";

import { fillOrder, type DialectAdapter, type FillTable, type PlanningDatabase } from "./adapter.ts";
import { createPostgresAdapter } from "./postgres-adapter.ts";
import { confirmsIndex, drizzleIndexLine, indexName } from "./rules.ts";
import type { IndexCandidate, PlanTable, SchemaTableKeys } from "./schema.ts";
import { plannedSizes, targetRows } from "./sizes.ts";
import { createSqliteAdapter } from "./sqlite-adapter.ts";
import { selectPlannableStatements, type PlannableStatement } from "./statements.ts";

const DIALECT_ADAPTERS = {
  postgresql: createPostgresAdapter,
  sqlite: createSqliteAdapter,
} as const satisfies Record<Dialect, (database: PlanningDatabase) => DialectAdapter>;

/** What the planning phase needs from a finished run */
export interface PlanQueriesInput {
  database: PlanningDatabase;
  dialect: Dialect;
  settings: QueryPlansSettings;
  /** The run's SQL events; only successful run-phase statements are planned. */
  events: readonly Pick<
    SqlEvent,
    "sequence" | "phase" | "kind" | "outcome" | "sql" | "parameters" | "namedParameters"
  >[];
  /** Drizzle property names per table, for the index line. */
  keys?: readonly SchemaTableKeys[];
  signal?: AbortSignal;
  /** Planning stops past this many milliseconds, even mid-statement; the run has its own deadline. */
  budgetMs?: number;
}

/** Planning gets most of the 30-second run limit, leaving time for the user's code and cleanup. */
export const PLANNING_BUDGET_MS = 20_000;

interface Plan {
  statement: PlannableStatement;
  raw: RawQueryPlan[];
  error?: unknown;
  reading?: Omit<QueryPlanReading, "indexes"> & { candidates: IndexCandidate[] };
  indexes: ConfirmedIndex[];
}

/**
 * The planning phase: after the user's code ran and its results were captured, fills the run's own
 * tables size by size, refreshes statistics, plans every run-phase query, and tries the indexes the
 * plans call for. It never throws for a database problem: the report carries the error instead.
 */
export async function planQueries(input: PlanQueriesInput): Promise<QueryPlansReport> {
  const startedAtMs = performance.now();
  const deadlineMs = startedAtMs + (input.budgetMs ?? PLANNING_BUDGET_MS);
  const selection = selectPlannableStatements(input.events);
  const fills: QueryPlanFill[] = [];
  const skipped = [...selection.skipped];
  const plans: Plan[] = selection.statements.map((statement) => ({ statement, raw: [], indexes: [] }));
  const expiry = createPlanningExpiry(deadlineMs, input.signal);
  // Once expired, nothing more reaches the database: it may still be busy with the statement that was cut short.
  const adapter = DIALECT_ADAPTERS[input.dialect]({
    call: (operation, value) =>
      expiry.isExpired() ? expiry.expired : Promise.race([input.database.call(operation, value), expiry.expired]),
  });
  let failure: unknown;

  const assertCanContinue = () => {
    if (input.signal?.aborted === true) {
      throw createCancelledError();
    }

    if (performance.now() > deadlineMs) {
      throw createOutOfTimeError();
    }
  };

  if (plans.length > 0) {
    let tables: FillTable[] = [];
    let rows = new Map<PlanTable, number>();

    try {
      tables = attachKeys(await adapter.introspect(), input.keys ?? []);
      const involved = getInvolvedTables(
        tables,
        plans.map((plan) => plan.statement.sql),
      );
      const order = fillOrder(tables, involved);
      const unfilled = [...involved].filter((table) => !order.includes(table));

      for (const size of plannedSizes(input.settings.size)) {
        assertCanContinue();
        const fillStartedAtMs = performance.now();

        if (size !== "seed") {
          if (unfilled.length > 0) {
            throw new Error(
              unfilled.map((table) => table.unfillable ?? `${table.name} is part of a reference cycle`).join("; "),
            );
          }

          const existing = new Map<string, number>();

          for (const table of order) {
            existing.set(toTableKey(table), await adapter.countRows(table));
          }

          const fillGraph = order.map((table) => ({
            key: toTableKey(table),
            parents: table.parents.map((index) => toTableKey(tables[index])),
          }));
          const targets = targetRows(size, fillGraph, existing);
          await adapter.fill(order, new Map(order.map((table) => [table, targets.get(toTableKey(table)) ?? 0])));
        }

        await adapter.analyze([...involved]);

        const counted = new Map<PlanTable, number>();

        for (const table of involved) {
          counted.set(table, await adapter.countRows(table));
        }

        rows = counted;
        fills.push({
          size,
          tables: [...involved].map((table) => ({
            name: table.name,
            ...(table.schema === undefined ? {} : { schema: table.schema }),
            rows: counted.get(table) ?? 0,
          })),
          durationMs: size === "seed" ? 0 : Math.round(performance.now() - fillStartedAtMs),
        });

        const isChosenSize = size === input.settings.size;

        for (const plan of plans) {
          if (plan.error !== undefined) {
            continue;
          }

          assertCanContinue();

          try {
            plan.raw.push(await adapter.explain(plan.statement, size, isChosenSize && input.settings.measureRealTime));
          } catch (cause) {
            // Running out of time is not this query's error: it keeps the reading from the sizes it reached.
            if (expiry.isExpired()) {
              throw cause;
            }

            plan.error = cause;
          }
        }
      }
    } catch (cause) {
      failure = cause;
    }

    for (const plan of plans) {
      const last = plan.raw.at(-1);

      if (plan.error === undefined && last !== undefined) {
        try {
          plan.reading = adapter.read(last, plan.statement, tables, rows);
        } catch (cause) {
          plan.error = cause;
        }
      }
    }

    try {
      if (failure === undefined) {
        await tryIndexes(adapter, plans, input.settings.size, assertCanContinue);
      }
    } catch (cause) {
      failure = cause;
    } finally {
      try {
        await adapter.cleanup();
      } catch (cause) {
        failure ??= cause;
      }
    }
  }

  expiry.dispose();

  const queries: PlannedQuery[] = plans.map((plan) => ({
    sequences: plan.statement.sequences,
    sql: plan.statement.sql,
    parameters: plan.statement.parameters,
    ...(plan.statement.namedParameters === undefined ? {} : { namedParameters: plan.statement.namedParameters }),
    raw: plan.raw,
    ...(plan.reading === undefined
      ? {}
      : { reading: { summary: plan.reading.summary, verdict: plan.reading.verdict, indexes: plan.indexes } }),
    ...(plan.error === undefined ? {} : { error: serializeError(plan.error) }),
  }));

  return {
    settings: { ...input.settings },
    dialect: input.dialect,
    fills,
    queries,
    skipped,
    durationMs: Math.round(performance.now() - startedAtMs),
    ...(failure === undefined ? {} : { error: serializeError(failure) }),
  };
}

function createCancelledError() {
  return new DOMException("Planning was cancelled", "AbortError");
}

function createOutOfTimeError() {
  return new Error("Planning ran out of time; the plans made so far are kept.");
}

/**
 * Planning expiry
 *
 * `expired` rejects once the budget is spent or `signal` aborts. Every database call races it: PGlite cannot interrupt
 * a statement, so a query slower than the budget would otherwise hold the run until its 30-second limit fails it. The
 * statement keeps running in the database worker, which the execution session then closes.
 */
function createPlanningExpiry(deadlineMs: number, signal: AbortSignal | undefined) {
  const { promise: expired, reject } = Promise.withResolvers<never>();
  let isExpired = false;
  const expire = (cause: Error) => {
    isExpired = true;
    reject(cause);
  };
  const expireOnAbort = () => expire(createCancelledError());
  const timer = setTimeout(() => expire(createOutOfTimeError()), Math.max(0, deadlineMs - performance.now()));

  // A planning that ends in time never observes the rejection.
  expired.catch(() => undefined);
  signal?.addEventListener("abort", expireOnAbort, { once: true });

  if (signal?.aborted === true) {
    expireOnAbort();
  }

  return {
    expired,
    isExpired: () => isExpired,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", expireOnAbort);
    },
  };
}

/**
 * Each candidate index is added once to the filled tables, every query that asked for it is planned
 * again, and the index is dropped. It is kept for a query only when the tenfold rule holds.
 */
async function tryIndexes(
  adapter: DialectAdapter,
  plans: Plan[],
  size: QueryPlansSettings["size"],
  assertCanContinue: () => void,
): Promise<void> {
  const groups = new Map<string, { candidate: IndexCandidate; plans: Plan[] }>();

  for (const plan of plans) {
    for (const candidate of plan.reading?.candidates ?? []) {
      const key = `${candidate.table.schema ?? ""}.${candidate.table.name}(${candidate.columns.join(",")})`;
      const group = groups.get(key) ?? { candidate, plans: [] };
      group.plans.push(plan);
      groups.set(key, group);
    }
  }

  if (groups.size === 0) {
    return;
  }

  const taken = await adapter.indexNames();

  for (const { candidate, plans: asking } of groups.values()) {
    assertCanContinue();
    const name = indexName(candidate.table.name, candidate.columns, taken);
    taken.add(name);
    await adapter.createIndex(candidate.table, name, candidate.columns);

    try {
      for (const plan of asking) {
        const before = plan.raw.at(-1);
        const beforeMeasure = before === undefined ? undefined : adapter.measure(before);

        if (before === undefined || beforeMeasure === undefined) {
          continue;
        }

        assertCanContinue();
        const after = await adapter.explain(plan.statement, size, false);
        const afterMeasure = adapter.measure(after);

        if (afterMeasure === undefined) {
          continue;
        }

        const confirmed = confirmsIndex({
          used: adapter.usesIndex(after, name),
          unit: beforeMeasure.unit,
          before: beforeMeasure.value,
          after: afterMeasure.value,
        });

        if (confirmed) {
          plan.indexes.push({
            trigger: candidate.trigger,
            table: candidate.table.name,
            ...(candidate.table.schema === undefined ? {} : { schema: candidate.table.schema }),
            columns: [...candidate.columns],
            name,
            drizzle: drizzleIndexLine(name, candidate.columns, candidate.table.keys),
            measure: { unit: beforeMeasure.unit, before: beforeMeasure.value, after: afterMeasure.value },
            before,
            after,
          });
        }
      }
    } finally {
      await adapter.dropIndex(candidate.table, name);
    }
  }
}

function toTableKey(table: PlanTable): string {
  return `${table.schema ?? ""}.${table.name}`;
}

/** Tables a statement names, plus every table they reference, since their rows must exist first. */
function getInvolvedTables(tables: readonly FillTable[], statements: readonly string[]): Set<FillTable> {
  const involved = new Set<FillTable>();
  const addTable = (table: FillTable) => {
    if (involved.has(table)) {
      return;
    }

    involved.add(table);

    for (const index of table.parents) {
      addTable(tables[index]);
    }
  };

  for (const table of tables) {
    const pattern = new RegExp(`(?:"${escapeRegExp(table.name)}"|\\b${escapeRegExp(table.name)}\\b)`, "i");

    if (statements.some((sql) => pattern.test(sql))) {
      addTable(table);
    }
  }

  return involved;
}

function attachKeys<T extends PlanTable>(tables: T[], keys: readonly SchemaTableKeys[]): T[] {
  for (const table of tables) {
    const match =
      keys.find((entry) => entry.name === table.name && (entry.schema ?? "public") === (table.schema ?? "public")) ??
      keys.find((entry) => entry.name === table.name);

    if (match !== undefined) {
      table.keys = match.columns;
    }
  }

  return tables;
}
