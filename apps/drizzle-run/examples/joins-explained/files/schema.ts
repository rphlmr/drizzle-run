import { boolean, integer, pgTable, text } from "drizzle-orm/pg-core";

export const authors = pgTable("authors", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
});

export const books = pgTable("books", {
  id: integer("id").primaryKey(),
  authorId: integer("author_id").references(() => authors.id),
  title: text("title").notNull(),
  published: boolean("published").notNull().default(false),
});
