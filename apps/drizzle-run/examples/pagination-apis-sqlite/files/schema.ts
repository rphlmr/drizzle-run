import { defineRelations } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const posts = sqliteTable("posts", {
  id: integer("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: text("created_at").notNull(),
}, (post) => [index("posts_created_at_id_idx").on(post.createdAt, post.id)]);

export const relations = defineRelations({ posts });
