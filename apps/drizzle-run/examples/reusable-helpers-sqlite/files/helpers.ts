import { type GetColumnData, type SQL, is, sql } from "drizzle-orm";
import { type AnySQLiteColumn, SQLiteBoolean } from "drizzle-orm/sqlite-core";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type JsonColumn = AnySQLiteColumn<{
  dataType: "string" | "number int53" | "boolean";
  data: string | number | boolean;
}>;

type JsonField = JsonColumn | SQL<JsonValue>;

type JsonObject<Shape extends Record<string, JsonField>> = {
  [Key in keyof Shape]: Shape[Key] extends JsonColumn
    ? GetColumnData<Shape[Key]>
    : Shape[Key] extends SQL<infer Value>
      ? Value
      : never;
} & {};

/**
 * Build and decode a JSON object with inferred keys, values and column nullability.
 * Supports built-in text, integer and boolean-mode columns, and JSON-compatible SQL expressions.
 * Nested helper calls are inlined; JSON text read from storage or a subquery needs json() before nesting.
 * Use columns from the source table or inner joins, not the nullable side of an outer join.
 */
export function jsonObject<Shape extends Record<string, JsonField>>(shape: Shape): SQL<JsonObject<Shape>> {
  const entries = Object.entries(shape).map(([key, value]) => {
    const jsonValue = is(value, SQLiteBoolean)
      ? sql`json(case when ${value} is null then 'null' when ${value} then 'true' else 'false' end)`
      : value;

    return sql`${key}, ${jsonValue}`;
  });

  return sql<string>`json_object(${sql.join(entries, sql`, `)})`.mapWith((value): JsonObject<Shape> => {
    // json_object constructs this shape; SQL expression types are the caller's contract.
    return JSON.parse(value);
  });
}
