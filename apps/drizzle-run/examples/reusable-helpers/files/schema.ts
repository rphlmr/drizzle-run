import { boolean, integer, pgTable, text } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  bio: text("bio"),
  active: boolean("active").notNull(),
});

export const posts = pgTable("posts", {
  id: integer("id").primaryKey(),
  authorId: integer("author_id").notNull().references(() => users.id),
  title: text("title").notNull(),
});
