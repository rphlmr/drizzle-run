import type { PostgresDatabaseDescription, RunResult, SerializedValue } from "../contracts/index.ts";
import { findLastDisplayValues, toComparable, toDisplayRows } from "../shared/display-rows.ts";
import type { CheckSpec } from "./spec.ts";

/** One check and whether the run passed it. */
export interface CheckResult<Check extends CheckSpec = CheckSpec> {
  check: Check;
  passed: boolean;
}

/** The parts of a `RunResult` that checks read, so recorded fixtures stay small. */
export type CheckedResult = Pick<RunResult, "outcome" | "displays" | "sql" | "database">;

/** SQLite tables extend this shape, so one type covers both dialects. */
type DatabaseTableDescription = PostgresDatabaseDescription["schemas"][number]["tables"][number];

/** Solution displays for one step, keyed by display label. */
type ExpectedDisplays = Readonly<Record<string, readonly SerializedValue[]>>;

/** What checks read beside the run. */
export interface CheckContext {
  /** The solution's displays for this step, keyed by label, as recorded by replaying the solution. */
  expected?: ExpectedDisplays;
  /** The files the learner ran, by path; for one side of a side-by-side project, that side's files. */
  files?: Readonly<Record<string, string>>;
}

function hasSameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

/** Accepts `posts` or `public.posts` for a table in a named schema. */
function toTableName(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1);
}

function findTable(result: CheckedResult, name: string): DatabaseTableDescription | undefined {
  const database = result.database;

  if (database === undefined) {
    return undefined;
  }

  const qualifier = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : undefined;
  const tables =
    database.dialect === "sqlite"
      ? database.tables
      : database.schemas
          .filter((schema) => qualifier === undefined || schema.name === qualifier)
          .flatMap((schema) => schema.tables);

  return tables.find((table) => table.name === toTableName(name));
}

function getRowColumns(row: SerializedValue): string[] {
  return row.type === "object" ? Object.keys(row.value) : [];
}

/**
 * Compare two lists of serialized values
 *
 * Object keys never matter in order. Arrays compare in any order unless `ordered` is true, and keys listed in
 * `ignore` are dropped at every depth.
 */
export function sameValues(
  actual: readonly SerializedValue[],
  expected: readonly SerializedValue[],
  options: { ordered?: boolean; ignore?: readonly string[] } = {},
): boolean {
  const comparableOptions = { ignore: new Set(options.ignore), ordered: options.ordered ?? false };
  const encode = (values: readonly SerializedValue[]) =>
    JSON.stringify(values.map((value) => toComparable(value, comparableOptions)));

  return encode(actual) === encode(expected);
}

function isCheckPassed(check: CheckSpec, result: CheckedResult, context: CheckContext): boolean {
  switch (check.type) {
    case "noError":
      return result.outcome === "succeeded";
    case "table": {
      const table = findTable(result, check.name);

      if (table === undefined) {
        return false;
      }

      return (check.columns ?? []).every((wantedColumn) =>
        table.columns.some(
          (column) =>
            column.name === wantedColumn.name &&
            (wantedColumn.dataType === undefined ||
              column.dataType.toLowerCase() === wantedColumn.dataType.toLowerCase()) &&
            (wantedColumn.nullable === undefined || column.nullable === wantedColumn.nullable),
        ),
      );
    }
    case "foreignKey":
      return (
        findTable(result, check.table)?.foreignKeys.some(
          (foreignKey) =>
            hasSameNames(foreignKey.columns, check.columns) &&
            toTableName(foreignKey.referencedTable) === toTableName(check.references.table) &&
            hasSameNames(foreignKey.referencedColumns, check.references.columns),
        ) ?? false
      );
    case "index":
      return (
        findTable(result, check.table)?.indexes.some(
          (index) =>
            hasSameNames(index.columns, check.columns) && (check.unique === undefined || index.unique === check.unique),
        ) ?? false
      );
    case "display": {
      const values = findLastDisplayValues(result.displays, check.label);

      if (!values) {
        return false;
      }

      const rows = toDisplayRows(values);
      const columns = new Set(rows.flatMap(getRowColumns));

      return (
        (check.rowCount === undefined || rows.length === check.rowCount) &&
        (check.columns ?? []).every((column) => columns.has(column))
      );
    }
    case "matchesSolution": {
      const values = findLastDisplayValues(result.displays, check.label);
      const expectedValues =
        context.expected !== undefined && Object.hasOwn(context.expected, check.label)
          ? context.expected[check.label]
          : undefined;

      return values !== undefined && expectedValues !== undefined && sameValues(values, expectedValues, check);
    }
    case "sqlExecuted": {
      const needle = check.contains.toLowerCase();

      return result.sql.some(
        (event) =>
          event.phase === "run" &&
          event.kind === "executed" &&
          event.outcome === "succeeded" &&
          event.sql.toLowerCase().includes(needle),
      );
    }
    case "fileContains":
      // Own keys only: a file named like an Object.prototype member, such as "toString", is not a project file.
      return context.files !== undefined && Object.hasOwn(context.files, check.file)
        ? (context.files[check.file]?.includes(check.contains) ?? false)
        : false;
  }
}

/**
 * Evaluate a step's checks on a finished run
 *
 * A `matchesSolution` check fails when `context.expected` has no display for its label, and a `fileContains` check
 * when `context.files` has no such file. Text matches are case sensitive, as code is.
 */
export function evaluateChecks<Check extends CheckSpec>(
  result: CheckedResult,
  checks: readonly Check[],
  context: CheckContext = {},
): CheckResult<Check>[] {
  return checks.map((check) => ({ check, passed: isCheckPassed(check, result, context) }));
}
