import { integer, pgTable, text } from "drizzle-orm/pg-core";

export const authors = pgTable("authors", { id: integer("id").primaryKey(), name: text("name").notNull() });

export const comments = pgTable("comments", {
  id: integer("id").primaryKey(),
  authorId: integer("author_id").notNull().references(() => authors.id),
  text: text("text"),
});
