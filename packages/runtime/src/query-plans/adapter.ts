import type { QueryPlanReading, QueryPlanSize, RawQueryPlan } from "@drizzle-run/core/contracts";
import * as z from "zod/mini";

import { PlainRecordSchema } from "../schema.ts";
import type { IndexCandidate, PlanTable } from "./schema.ts";
import type { PlannableStatement } from "./statements.ts";

/** The database worker as the planner sees it: the same `call` the guest's operations go through. */
export interface PlanningDatabase {
  call(operation: string, value: unknown): Promise<unknown>;
}

/** A table the planner can fill: what the reader needs plus how to generate its rows. */
export interface FillTable extends PlanTable {
  /** Tables this one references, as indexes into the introspected list. */
  parents: readonly number[];
  /** Rows that cannot be generated (a type with no generator, a self reference that cannot be null). */
  unfillable?: string;
}

/** Everything that differs between Postgres and SQLite while planning. */
export interface DialectAdapter {
  introspect(): Promise<FillTable[]>;
  countRows(table: FillTable): Promise<number>;
  /** Adds rows until each table holds its target; parents always come before their children. */
  fill(tables: readonly FillTable[], targets: ReadonlyMap<FillTable, number>): Promise<void>;
  analyze(tables: readonly FillTable[]): Promise<void>;
  explain(statement: PlannableStatement, size: QueryPlanSize, measure: boolean): Promise<RawQueryPlan>;
  read(
    raw: RawQueryPlan,
    statement: PlannableStatement,
    tables: readonly PlanTable[],
    rows: ReadonlyMap<PlanTable, number>,
  ): Omit<QueryPlanReading, "indexes"> & { candidates: IndexCandidate[] };
  /** Postgres total cost or SQLite median time, the measure the tenfold rule compares. */
  measure(raw: RawQueryPlan): { unit: "cost" | "ms"; value: number } | undefined;
  usesIndex(raw: RawQueryPlan, name: string): boolean;
  indexNames(): Promise<Set<string>>;
  createIndex(table: PlanTable, name: string, columns: readonly string[]): Promise<void>;
  dropIndex(table: PlanTable, name: string): Promise<void>;
  /** Restores session settings and drops the planner's helper tables. */
  cleanup(): Promise<void>;
}

/** True for INSERT, UPDATE and DELETE statements, including those behind a WITH clause. */
export function isWrite(sql: string): boolean {
  return /^\s*(?:insert|update|delete)\b/i.test(sql) || /^\s*with\b[\s\S]*\b(?:insert|update|delete)\b/i.test(sql);
}

const PlanningRowsSchema = z.pipe(PlainRecordSchema, z.object({ rows: z.array(PlainRecordSchema) }));

/** Run a planning query and return its rows; throws a `TypeError` when the database returns no rows array. */
export function queryRows(database: PlanningDatabase, value: unknown): Promise<Record<string, unknown>[]> {
  return database.call("plan.query", value).then((result) => {
    const planning = PlanningRowsSchema.safeParse(result);

    if (!planning.success) {
      throw new TypeError("The database returned no planning rows");
    }

    return planning.data.rows;
  });
}

/** Parents first; tables in a reference cycle are left out of the order and so never filled. */
export function fillOrder(tables: readonly FillTable[], selected: ReadonlySet<FillTable>): FillTable[] {
  const ordered: FillTable[] = [];
  const visitStates = new Map<FillTable, "visiting" | "done">();
  const fillable = new Map<FillTable, boolean>();
  const visitTable = (table: FillTable): boolean => {
    const visitState = visitStates.get(table);

    if (visitState === "done") {
      return fillable.get(table) ?? false;
    }

    if (visitState === "visiting") {
      return false;
    }

    visitStates.set(table, "visiting");
    const isReady =
      table.unfillable === undefined &&
      table.parents.every((index) => {
        const parent = tables[index];

        return parent === table || visitTable(parent);
      });
    visitStates.set(table, "done");
    fillable.set(table, isReady);

    if (isReady) {
      ordered.push(table);
    }

    return isReady;
  };

  for (const table of selected) {
    visitTable(table);
  }

  return ordered.filter((table) => selected.has(table));
}

/** A database value as text; `null` and `undefined` become an empty string, and an object its JSON. */
export function stringValue(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;

    case "undefined":
      return "";

    case "object":
      return value === null ? "" : JSON.stringify(value);

    case "number":
    case "bigint":
    case "boolean":
    case "symbol":
    case "function":
      return String(value);
  }
}

/** A database value as a number; `null` and `undefined` become 0, and bigints are narrowed. */
export function numberValue(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

/** A JSON array, or its text, as strings; anything else becomes an empty list. Throws on invalid JSON text. */
export function jsonList(value: unknown): string[] {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;

  return Array.isArray(parsed) ? parsed.map(stringValue) : [];
}

/** Quote a string as an SQL literal, doubling its single quotes. */
export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
