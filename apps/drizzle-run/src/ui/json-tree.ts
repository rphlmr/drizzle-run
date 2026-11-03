import type { SerializedValue } from "@drizzle-run/core/contracts";
import { uniq } from "es-toolkit";

type ObjectValue = Extract<SerializedValue, { type: "object" }>;

/** A leaf as JSON writes it; values JSON cannot hold keep a readable form. */
export function toJsonLiteral(value: SerializedValue): string {
  switch (value.type) {
    case "primitive":
      return typeof value.value === "string" ? JSON.stringify(value.value) : String(value.value);
    case "bigint":
      return `${value.value}n`;
    case "date":
      return JSON.stringify(value.value);
    case "undefined":
      return "undefined";
    case "circular":
      return `↻ ${value.path}`;
    case "unsupported":
      return value.description ? `${value.valueType}: ${value.description}` : value.valueType;
    case "array":
      return value.value.length === 0 ? "[]" : "[…]";
    case "object":
      return Object.keys(value.value).length === 0 ? "{}" : "{…}";
  }
}

/** A container's size, as a folded node or a depth chip shows it: "3 items", "1 field". */
export function getSizeLabel(value: Extract<SerializedValue, { type: "array" | "object" }>): string {
  const [count, noun] =
    value.type === "array" ? [value.value.length, "item"] : [Object.keys(value.value).length, "field"];

  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Relation tables nest this many levels under a result's rows; a deeper relation shows as a chip. */
export const NESTED_TABLE_DEPTH = 2;

/** `many` for a relation that loads an array of objects, `one` for one that loads an object. */
export type RelationHint = "many" | "one";

function isObjectValue(value: SerializedValue): value is ObjectValue {
  return value.type === "object";
}

/** The rows a value shows as a table: an array of objects, or an object as a single row. */
export function getTableRows(value: SerializedValue): readonly ObjectValue[] | undefined {
  if (value.type === "object") {
    return Object.keys(value.value).length > 0 ? [value] : undefined;
  }

  return value.type === "array" && value.value.length > 0 && value.value.every(isObjectValue) ? value.value : undefined;
}

/**
 * A column's relation hint: every value is an array of objects (`many`) or an object (`one`); empty arrays and nulls
 * fit either.
 */
export function getRelationHint(values: readonly (SerializedValue | undefined)[]): RelationHint | undefined {
  let hint: RelationHint | undefined;

  for (const value of values) {
    if (value === undefined || (value.type === "primitive" && value.value === null)) {
      continue;
    }

    const kind =
      value.type === "array" && value.value.every(isObjectValue) ? "many" : value.type === "object" ? "one" : undefined;

    if (kind === undefined || (hint !== undefined && hint !== kind)) {
      return undefined;
    }

    hint = kind;
  }

  return hint;
}

/** A table column: its name, whether it holds relations, and whether it fits its content. */
export interface TableColumn {
  name: string;
  hint: RelationHint | undefined;
  /** The column's relations show as tables; past NESTED_TABLE_DEPTH they show as chips. */
  nested: boolean;
  /** The column is as wide as its content; with nested columns in the table, they take the rest. */
  fit: boolean;
}

/** The columns of a table at `level` (0 for a result's rows), in first-seen order. */
export function getTableColumns(rows: readonly ObjectValue[], level: number): TableColumn[] {
  const columns = uniq(rows.flatMap((row) => Object.keys(row.value))).map((name) => {
    const hint = getRelationHint(rows.map((row) => row.value[name]));

    return { name, hint, nested: hint !== undefined && level < NESTED_TABLE_DEPTH };
  });
  const nested = columns.some((column) => column.nested);

  return columns.map((column) => ({ ...column, fit: !column.nested && (nested || column.hint !== undefined) }));
}
