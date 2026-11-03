import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// SQLite stores booleans and dates as integers; the column mode turns them back into true/false and Date.
export const tasks = sqliteTable("tasks", {
  id: integer().primaryKey({ autoIncrement: true }),
  title: text().notNull(),
  done: integer({ mode: "boolean" }).notNull().default(false),
  dueAt: integer({ mode: "timestamp" }).notNull(),
});
