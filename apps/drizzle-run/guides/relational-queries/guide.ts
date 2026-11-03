import { resolveSupportedTuple } from "@drizzle-run/core/catalog";
import { defineGuideManifest } from "@drizzle-run/core/guide";
import { defineRunManifest } from "@drizzle-run/core/manifest";
import { createPairManifest, type PairManifest } from "@drizzle-run/core/pair";

import { readExampleFiles } from "../example-files.ts";
import type { DrizzleRunGuideMeta, DrizzleRunStepMeta } from "../meta.ts";

const docs = { label: "Relational queries docs", href: "https://orm.drizzle.team/docs/rqb" };
const target = { dialect: "postgresql" } as const;
const example = readExampleFiles("relational-queries", ["schema.ts", "seed.ts", "query.ts"]);

// The newest release runs the example as it is; 0.45 runs the same queries in its own API.
const next = defineRunManifest({
  kind: "drizzle-run",
  manifestVersion: 1,
  target,
  dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
  files: example,
  entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "query.ts" },
});

const legacySchema = `import { relations } from "drizzle-orm";
import { integer, pgTable, serial, text } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});

export const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  authorId: integer("author_id").notNull().references(() => users.id),
  title: text("title").notNull(),
});

export const comments = pgTable("comments", {
  id: serial("id").primaryKey(),
  postId: integer("post_id").notNull().references(() => posts.id),
  authorId: integer("author_id").notNull().references(() => users.id),
  body: text("body").notNull(),
});

// Relations are declared per table, each with relations().
export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
  comments: many(comments),
}));
export const postsRelations = relations(posts, ({ one, many }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
  comments: many(comments),
}));
export const commentsRelations = relations(comments, ({ one }) => ({
  post: one(posts, { fields: [comments.postId], references: [posts.id] }),
  author: one(users, { fields: [comments.authorId], references: [users.id] }),
}));
`;

const legacyQuery = `import { db } from "@drizzle-run/runtime/context";

// One call returns nested objects: each user with their posts, and each post with its comments.
const authors = await db.query.users.findMany({
  columns: { name: true },
  with: {
    posts: {
      columns: { title: true },
      orderBy: (posts, { asc }) => [asc(posts.id)],
      with: {
        comments: {
          columns: { body: true },
          orderBy: (comments, { asc }) => [asc(comments.id)],
          with: { author: { columns: { name: true } } },
        },
      },
    },
  },
  orderBy: (users, { asc }) => [asc(users.id)],
});

$.display("Authors with posts and comments", authors);
`;

const pair = createPairManifest(
  next,
  [
    resolveSupportedTuple({ target, ormVersion: "0.45.4", kitVersion: "0.31.11" }),
    resolveSupportedTuple({ target, ormVersion: "1.0.0-rc.5", kitVersion: "1.0.0-rc.5" }),
  ],
  "separate",
);

const project: PairManifest = {
  ...pair,
  sides: [{ ...pair.sides[0], files: { "schema.ts": legacySchema, "query.ts": legacyQuery } }, pair.sides[1]],
};

const namedLegacy = `

// 0.45: where is a callback that receives the columns and the operators.
const named = await db.query.users.findMany({
  columns: { name: true },
  where: (users, { like }) => like(users.name, "A%"),
});

$.display("Names starting with A", named);
`;

const namedNext = `

// 1.0: where is a plain object, keyed by column.
const named = await db.query.users.findMany({
  columns: { name: true },
  where: { name: { like: "A%" } },
});

$.display("Names starting with A", named);
`;

export const guide = defineGuideManifest<DrizzleRunGuideMeta, DrizzleRunStepMeta>()({
  kind: "drizzle-run-guide",
  manifestVersion: 1,
  id: "58b9a8cb-aa44-44a5-ace3-0824b87f2b71",
  title: "Relational queries, 0.45 to 1.0",
  description: "Compare relational queries on Drizzle ORM 0.45.4 and 1.0.0-rc.5, side by side.",
  project,
  steps: [
    {
      type: "walkthrough",
      id: "01-relations",
      label: "Relations",
      title: "Relations in one place",
      body: "This guide compares Drizzle ORM **0.45.4** with **1.0.0-rc.5**. In 0.45.4, each table gets its own `relations()` call. In 1.0.0-rc.5, `defineRelations` groups the relations in one declaration.\n\nThe query on each side loads the same authors, posts and comments. Press **Run** to compare them. If you are learning relations for the first time, start with [Drizzle in five minutes](/examples/drizzle-in-five-minutes).",
      focus: { file: "schema.ts", side: 1, lines: [22, 36] },
      run: "required",
      highlight: { displays: ["Authors with posts and comments"] },
      links: [docs],
      meta: {
        summary: "Two ways to declare the same relations.",
        changed: "Both sides returned the same authors, posts, and comments.",
      },
    },
    {
      type: "walkthrough",
      id: "02-filters",
      label: "Filters",
      title: "Filters become objects",
      body: "In 0.45, `where` takes a callback with operators. In 1.0 it takes a plain object keyed by column.\n\nSame query, same rows. Only the filter syntax differs.",
      edits: [
        {
          file: "query.ts",
          side: 0,
          replace: {
            anchor: '$.display("Authors with posts and comments", authors);\n',
            with: `$.display("Authors with posts and comments", authors);${namedLegacy}`,
          },
        },
        {
          file: "query.ts",
          side: 1,
          replace: {
            anchor: '$.display("Posts Ada commented on", commentedByAda);\n',
            with: `$.display("Posts Ada commented on", commentedByAda);${namedNext}`,
          },
        },
      ],
      run: "required",
      highlight: { displays: ["Names starting with A"] },
      links: [docs],
      meta: {
        summary: "Filter by name on both sides.",
        changed: "Both sides found Ada.",
      },
    },
    {
      type: "walkthrough",
      id: "03-nested",
      label: "Nested",
      title: "Nested with, limit, orderBy",
      body: "`with` nests the same way on both releases. `orderBy` is a callback in 0.45 and an object in 1.0; `limit` works the same.\n\nThe name filter still selects Ada. Inside her posts, descending ID order and `limit: 1` keep only the post with the highest ID. This limits her posts, not the number of users.",
      edits: [
        {
          file: "query.ts",
          side: 0,
          replace: {
            anchor: '  where: (users, { like }) => like(users.name, "A%"),\n',
            with: '  where: (users, { like }) => like(users.name, "A%"),\n  with: { posts: { columns: { title: true }, orderBy: (posts, { desc }) => [desc(posts.id)], limit: 1 } },\n',
          },
        },
        {
          file: "query.ts",
          side: 1,
          replace: {
            anchor: '  where: { name: { like: "A%" } },\n',
            with: '  where: { name: { like: "A%" } },\n  with: { posts: { columns: { title: true }, orderBy: { id: "desc" }, limit: 1 } },\n',
          },
        },
      ],
      run: "required",
      highlight: { displays: ["Names starting with A"] },
      links: [docs],
      meta: {
        summary: "Load Ada with just her highest-ID post.",
        changed: "Both sides returned Ada with one post: Relations in one query.",
      },
    },
    {
      type: "walkthrough",
      id: "04-columns",
      label: "Columns",
      title: "Partial columns",
      body: "`columns` reads the same on both releases: `true` picks a column, `false` leaves it out and keeps the rest.",
      edits: [
        {
          file: "query.ts",
          side: 0,
          replace: {
            anchor: "  columns: { name: true },\n  where: (users",
            with: "  columns: { id: false },\n  where: (users",
          },
        },
        {
          file: "query.ts",
          side: 1,
          replace: {
            anchor: "  columns: { name: true },\n  where: { name",
            with: "  columns: { id: false },\n  where: { name",
          },
        },
      ],
      run: "required",
      highlight: { displays: ["Names starting with A"] },
      links: [docs],
      meta: {
        summary: "Leave out a column instead of picking one.",
        changed: "Both sides omitted `id` and returned the other columns.",
      },
    },
  ],
  meta: { slug: "relational-queries", status: "published", example: "b77031e5-1ac6-4750-8533-ca4006ba60df" },
});
