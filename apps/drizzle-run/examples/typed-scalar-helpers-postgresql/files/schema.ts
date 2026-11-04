import { integer, pgTable, text } from "drizzle-orm/pg-core";

export const authors = pgTable("authors", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
});

export const scores = pgTable("scores", {
  id: integer("id").primaryKey(),
  authorId: integer("author_id").notNull().references(() => authors.id),
  points: integer("points"),
});
