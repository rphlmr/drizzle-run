import { defineRelations } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const posts = pgTable("posts", {
  id: integer("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true, precision: 3 }).notNull(),
}, (post) => [index("posts_created_at_id_idx").on(post.createdAt, post.id)]);

export const relations = defineRelations({ posts });
