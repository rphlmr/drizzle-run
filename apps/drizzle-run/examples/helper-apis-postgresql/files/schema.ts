import { defineRelations } from "drizzle-orm";
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

export const relations = defineRelations({ users, posts }, (r) => ({
  posts: {
    author: r.one.users({ from: r.posts.authorId, to: r.users.id, optional: false }),
  },
}));
