import { defineRelations } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  bio: text("bio"),
  active: integer("active", { mode: "boolean" }).notNull(),
});

export const posts = sqliteTable("posts", {
  id: integer("id").primaryKey(),
  authorId: integer("author_id").notNull().references(() => users.id),
  title: text("title").notNull(),
});

export const relations = defineRelations({ users, posts }, (r) => ({
  posts: {
    author: r.one.users({ from: r.posts.authorId, to: r.users.id, optional: false }),
  },
}));
