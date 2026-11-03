import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const authors = sqliteTable("authors", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
});

export const books = sqliteTable("books", {
  id: integer("id").primaryKey(),
  authorId: integer("author_id").references(() => authors.id),
  title: text("title").notNull(),
  genre: text("genre").notNull(),
  year: integer("year").notNull(),
});
