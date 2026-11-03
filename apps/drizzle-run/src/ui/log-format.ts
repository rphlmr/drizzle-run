import type { SerializedValue, SqlEvent } from "@drizzle-run/core/contracts";

import { toJsonLiteral } from "./json-tree";

/** "0.2 ms" and "1.4 ms" under 10 ms, "21 ms" above, "1.3 s" past a second. */
export function formatStatementDuration(durationMs: number): string {
  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(1)} s`;
  }

  return durationMs < 10 ? `${durationMs.toFixed(1)} ms` : `${Math.round(durationMs)} ms`;
}

/** "1 row", "2 rows". */
export function formatRowCount(count: number): string {
  return count === 1 ? "1 row" : `${count} rows`;
}

/** A parameter as JSON, containers spelled out in full (a JSON column's value, an array parameter). */
function toParamJson(value: SerializedValue): string {
  if (value.type === "array") {
    return `[${value.value.map(toParamJson).join(", ")}]`;
  }

  if (value.type === "object") {
    return `{${Object.entries(value.value)
      .map(([key, item]) => `${JSON.stringify(key)}: ${toParamJson(item)}`)
      .join(", ")}}`;
  }

  return toJsonLiteral(value);
}

/** "$1 = 'Ada', $2 = 0", or "no params". Strings take SQL quotes; anything else shows as JSON. */
export function formatParams(parameters: readonly SerializedValue[]): string {
  if (parameters.length === 0) {
    return "no params";
  }

  return parameters
    .map((value, index) => {
      const literal =
        value.type === "primitive" && typeof value.value === "string"
          ? `'${value.value.replaceAll("'", "''")}'`
          : toParamJson(value);

      return `$${index + 1} = ${literal}`;
    })
    .join(", ");
}

/** How many characters a logged value's one-line preview holds before it ends in an ellipsis. */
const PREVIEW_LENGTH = 300;

function formatPreviewKey(key: string) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

/**
 * A value on one line, as a browser console previews it
 *
 * Keys are bare when they can be and strings keep their quotes: `[{ id: 1, title: "Hello" }]`. Past `maxLength` the
 * preview stops walking the value and ends in an ellipsis, so a thousand rows cost no more than the line shows.
 */
export function formatValuePreview(value: SerializedValue, maxLength = PREVIEW_LENGTH): string {
  let preview = "";
  const write = (part: string) => {
    preview += part;

    return preview.length <= maxLength;
  };
  const visit = (node: SerializedValue): boolean => {
    if (node.type === "array") {
      return write("[") && node.value.every((item, index) => (index === 0 || write(", ")) && visit(item)) && write("]");
    }

    if (node.type === "object") {
      const entries = Object.entries(node.value);

      if (entries.length === 0) {
        return write("{}");
      }

      return (
        write("{ ") &&
        entries.every(
          ([key, item], index) => (index === 0 || write(", ")) && write(`${formatPreviewKey(key)}: `) && visit(item),
        ) &&
        write(" }")
      );
    }

    return write(toJsonLiteral(node));
  };

  return visit(value) ? preview : `${preview.slice(0, maxLength)}…`;
}

/**
 * What a console call printed, on one line
 *
 * Its arguments are joined by spaces as the console prints them: strings as they are, anything else previewed.
 *
 * @example
 * formatConsoleLine([serializeValue("Found"), serializeValue([{ id: 1 }])]); // 'Found [{ id: 1 }]'
 */
export function formatConsoleLine(values: readonly SerializedValue[]): string {
  return values
    .map((value) =>
      value.type === "primitive" && typeof value.value === "string" ? value.value : formatValuePreview(value),
    )
    .join(" ");
}

/** The SQL as one line, for a Logs row: runs of whitespace become one space. */
export function toOneLineSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** How a statement's one-line SQL is colored: transaction control stands apart from the queries it wraps. */
export type StatementTone = "query" | "control" | "rollback";

/** Begin, commit and savepoints read as control; rollbacks as errors; everything else as a query. */
export function getStatementTone(sql: string): StatementTone {
  const head = sql.trimStart().slice(0, 32).toLowerCase();

  if (head.startsWith("rollback")) {
    return "rollback";
  }

  return /^(begin|start transaction|commit|end|savepoint|release)\b/.test(head) ? "control" : "query";
}

const commandPatterns: readonly [RegExp, string][] = [
  [/^create\s+table\b/i, "create table"],
  [/^create\s+(unique\s+)?index\b/i, "create index"],
  [/^create\s+(type|schema|view|materialized\s+view|sequence|extension)\b/i, "create"],
  [/^alter\b/i, "alter"],
  [/^drop\b/i, "drop"],
  [/^insert\b/i, "insert"],
  [/^update\b/i, "update"],
  [/^delete\b/i, "delete"],
  [/^select\b/i, "select"],
];

function getCommand(sql: string): string {
  const text = sql.trimStart();

  return commandPatterns.find(([pattern]) => pattern.test(text))?.[1] ?? "other";
}

/**
 * What a folded group of statements did, in the order it first did each: "create table, insert 2 rows". Writes with a
 * row count add it up; statements the summary has no word for are left out.
 */
export function summarizeStatements(statements: readonly SqlEvent[]): string {
  const commands = new Map<string, number | undefined>();

  for (const statement of statements) {
    const command = getCommand(statement.sql);

    if (command === "other") {
      continue;
    }

    const counted = command === "insert" || command === "update" || command === "delete";
    const previous = commands.get(command);
    const rows = counted && statement.rowCount !== undefined ? (previous ?? 0) + statement.rowCount : previous;

    commands.set(command, rows);
  }

  return [...commands]
    .map(([command, rows]) => (rows === undefined ? command : `${command} ${formatRowCount(rows)}`))
    .join(", ");
}

/** The rows a group of statements wrote or returned, when any of them reported a count. */
export function sumRowCounts(statements: readonly SqlEvent[]): number | undefined {
  const counts = statements.flatMap((statement) => (statement.rowCount === undefined ? [] : [statement.rowCount]));

  return counts.length === 0 ? undefined : counts.reduce((total, count) => total + count, 0);
}

/** The summed duration of a group of statements, when any of them was timed. */
export function sumDurations(statements: readonly SqlEvent[]): number | undefined {
  const durations = statements.flatMap((statement) =>
    statement.durationMs === undefined ? [] : [statement.durationMs],
  );

  return durations.length === 0 ? undefined : durations.reduce((total, duration) => total + duration, 0);
}
