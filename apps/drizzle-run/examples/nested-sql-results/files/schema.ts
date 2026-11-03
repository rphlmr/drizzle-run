import { defineRelations } from "drizzle-orm";
import { integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
});

export const files = pgTable("files", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
});

export const comments = pgTable("comments", {
  id: integer("id").primaryKey(),
  fileId: integer("file_id").notNull().references(() => files.id),
  authorId: integer("author_id").notNull().references(() => users.id),
  text: text("text"),
});

export const tags = pgTable("tags", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
});

export const fileTags = pgTable("file_tags", {
  fileId: integer("file_id").notNull().references(() => files.id),
  tagId: integer("tag_id").notNull().references(() => tags.id),
}, (table) => [primaryKey({ columns: [table.fileId, table.tagId] })]);

export const relations = defineRelations({ users, files, comments, tags, fileTags }, (r) => ({
  files: {
    comments: r.many.comments(),
    tags: r.many.tags({
      from: r.files.id.through(r.fileTags.fileId),
      to: r.tags.id.through(r.fileTags.tagId),
    }),
  },
  comments: {
    file: r.one.files({ from: r.comments.fileId, to: r.files.id }),
    author: r.one.users({ from: r.comments.authorId, to: r.users.id }),
  },
}));
