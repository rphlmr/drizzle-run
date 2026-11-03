import type { IndexTryTrigger } from "@drizzle-run/core/contracts";
import * as z from "zod/mini";

import { keepIfValid, PlainRecordSchema } from "../schema.ts";

/** What the plan reader needs to know about a table, read from the database itself. */
export interface PlanTable {
  name: string;
  schema?: string;
  columns: readonly string[];
  indexes: readonly { name: string; columns: readonly string[] }[];
  foreignKeys: readonly {
    columns: readonly string[];
    referencedTable: string;
    referencedSchema?: string;
    referencedColumns: readonly string[];
  }[];
  /** Database column name to the Drizzle table's property, when the guest reported it. */
  keys?: Readonly<Record<string, string>>;
}

/** An index the planner may try, with the plan line that suggested it */
export interface IndexCandidate {
  trigger: IndexTryTrigger;
  table: PlanTable;
  columns: readonly string[];
}

/** Drizzle table property names per database table, reported by the guest after the schema evaluates. */
export interface SchemaTableKeys {
  name: string;
  schema?: string;
  columns: Readonly<Record<string, string>>;
}

/**
 * Find a table by name
 *
 * Matches the exact name within `schema` when both sides know their schema, then falls back to a
 * case-insensitive name match. Returns `undefined` when nothing matches.
 */
export function findTable(tables: readonly PlanTable[], name: string, schema?: string): PlanTable | undefined {
  const exactMatch = tables.find(
    (table) => table.name === name && (schema === undefined || table.schema === undefined || table.schema === schema),
  );

  return exactMatch ?? tables.find((table) => table.name.toLowerCase() === name.toLowerCase());
}

/** True when an existing index already starts with these columns, so a new one would add nothing. */
export function hasLeadingIndex(table: PlanTable, columns: readonly string[]): boolean {
  return table.indexes.some((index) => columns.every((column, position) => index.columns[position] === column));
}

/** True when these columns form a foreign key that no index covers, in any column order. */
export function isUnindexedForeignKey(table: PlanTable, columns: readonly string[]): boolean {
  const sortedColumns = columns.toSorted().join("\u0000");
  const isForeignKey = table.foreignKeys.some((key) => key.columns.toSorted().join("\u0000") === sortedColumns);
  const hasCoveringIndex = table.indexes.some(
    (index) =>
      index.columns.length >= columns.length &&
      index.columns.slice(0, columns.length).toSorted().join("\u0000") === sortedColumns,
  );

  return isForeignKey && !hasLeadingIndex(table, columns) && !hasCoveringIndex;
}

/** Add an index candidate unless it is empty, already covered by an index, or already listed. */
export function addCandidate(candidates: IndexCandidate[], candidate: IndexCandidate): void {
  if (candidate.columns.length === 0 || hasLeadingIndex(candidate.table, candidate.columns)) {
    return;
  }

  const isKnown = candidates.some(
    (known) => known.table === candidate.table && known.columns.join(",") === candidate.columns.join(","),
  );

  if (!isKnown) {
    candidates.push(candidate);
  }
}

/** One table of the guest's description: a schema name that is not text is left out, as are columns that are not. */
const SchemaTableEntrySchema = z.pipe(
  PlainRecordSchema,
  z.object({
    name: z.string(),
    schema: keepIfValid(z.string()),
    columns: z.pipe(
      PlainRecordSchema,
      z.transform((columns) =>
        Object.fromEntries(
          Object.entries(columns).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
        ),
      ),
    ),
  }),
);

/** The guest's table description, checked before the planner trusts it. Anything malformed is dropped. */
export function parseSchemaTableKeys(input: unknown): SchemaTableKeys[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap((entry: unknown): SchemaTableKeys[] => {
    const table = SchemaTableEntrySchema.safeParse(entry);

    if (!table.success) {
      return [];
    }

    const { name, schema, columns } = table.data;

    return [{ name, ...(schema === undefined ? {} : { schema }), columns }];
  });
}
