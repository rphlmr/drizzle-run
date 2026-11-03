import { boolean, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// PostgreSQL has real boolean and timestamp columns.
export const tasks = pgTable("tasks", {
  id: serial().primaryKey(),
  title: text().notNull(),
  done: boolean().notNull().default(false),
  dueAt: timestamp({ mode: "date" }).notNull(),
});
