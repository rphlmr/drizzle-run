import { type GetColumnData, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

type JsonColumn = AnyPgColumn<{ dataType: "object json" }>;
type TextKey<Column extends JsonColumn> = {
  [Key in keyof GetColumnData<Column, "raw">]: GetColumnData<Column, "raw">[Key] extends string | null | undefined ? Key : never;
}[keyof GetColumnData<Column, "raw">] & string;
type ArrayKey<Column extends JsonColumn> = {
  [Key in keyof GetColumnData<Column, "raw">]: GetColumnData<Column, "raw">[Key] extends string[] | undefined ? Key : never;
}[keyof GetColumnData<Column, "raw">] & string;

/** Extract a declared text field; a missing key or JSON null returns SQL null. */
export function getJsonText<Column extends JsonColumn>(column: Column, key: TextKey<Column>): SQL<string | null> {
  return sql<string | null>`${column}->>${key}`;
}

/** Match an item in a declared string-array field; missing arrays contain no items. */
export function hasJsonArrayValue<Column extends JsonColumn>(column: Column, key: ArrayKey<Column>, value: string): SQL<boolean> {
  return sql<boolean>`exists (select 1 from jsonb_array_elements_text(coalesce(${column}->${key}, '[]'::jsonb)) as item(value) where item.value = ${value})`;
}
