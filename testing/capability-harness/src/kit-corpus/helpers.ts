import { timestamp } from "drizzle-orm/pg-core";

/**
 * Create `createdAt` and `updatedAt` columns
 *
 * A real imported helper: it returns new builders for each table and each oracle run.
 */
export function timestampColumns() {
  return {
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow(),
  };
}
