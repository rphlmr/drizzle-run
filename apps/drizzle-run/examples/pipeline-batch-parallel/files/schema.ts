import { integer, pgTable, text } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: integer().primaryKey(),
  name: text().notNull(),
});

export const posts = pgTable("posts", {
  id: integer().primaryKey(),
  authorId: integer().notNull().references(() => users.id),
  title: text().notNull(),
});
