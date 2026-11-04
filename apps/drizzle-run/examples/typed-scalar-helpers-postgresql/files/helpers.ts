import { type SQL, sql } from "drizzle-orm";

/** Return a number, using the fallback for SQL null and decoding the driver value. */
export function coalesceNumber(expression: SQL<number | null>, fallback: number): SQL<number> {
  return sql`coalesce(${expression}, ${fallback})`.mapWith(Number);
}
