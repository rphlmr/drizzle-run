import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const authors = sqliteTable("authors", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
});

export const scores = sqliteTable("scores", {
  id: integer("id").primaryKey(),
  authorId: integer("author_id").notNull().references(() => authors.id),
  points: integer("points"),
});
