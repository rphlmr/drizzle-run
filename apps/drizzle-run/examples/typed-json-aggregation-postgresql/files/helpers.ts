import { type GetColumnData, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// These built-in column types keep their JavaScript representation inside JSON.
type JsonColumn = AnyPgColumn<{
  dataType: "string" | "number int32" | "boolean";
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
 * Build a JSONB object with inferred keys, values and column nullability.
 * Supports built-in text, integer and boolean columns, and JSON-compatible SQL expressions.
 * SQL expression types must match PostgreSQL's JSON output; nested column decoders do not run.
 * Use columns from the source table or inner joins, not the nullable side of an outer join.
 */
export function jsonbBuildObject<Shape extends Record<string, JsonField>>(shape: Shape): SQL<JsonObject<Shape>> {
  const entries = Object.entries(shape).map(([key, value]) => sql`${key}::text, ${value}`);

  return sql<JsonObject<Shape>>`jsonb_build_object(${sql.join(entries, sql`, `)})`;
}

/** Aggregate ordered JSON; filter the child identifier rather than its nullable properties. */
export function jsonbAggregate<Value extends JsonValue>({ value, orderBy, present }: {
  value: SQL<Value>;
  orderBy: AnyPgColumn;
  present: AnyPgColumn<{ notNull: true }>;
}): SQL<Value[]> {
  return sql<Value[]>`coalesce(jsonb_agg(${value} order by ${orderBy}) filter (where ${present} is not null), '[]'::jsonb)`;
}
