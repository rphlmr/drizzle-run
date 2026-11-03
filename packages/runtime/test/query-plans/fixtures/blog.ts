import type { Dialect } from "@drizzle-run/core/catalog";
import { serializeValue, type SqlEvent } from "@drizzle-run/core/contracts";

import type { SchemaTableKeys } from "../../../src/query-plans/schema.ts";

/** Users, posts by author, and comments on posts. Both databases get the same shape. */
export const BLOG_SCHEMA = {
  postgresql: [
    `CREATE TABLE "users" ("id" serial PRIMARY KEY, "name" text NOT NULL, "email" text NOT NULL UNIQUE, "created_at" timestamp NOT NULL DEFAULT now())`,
    `CREATE TABLE "posts" ("id" serial PRIMARY KEY, "author_id" integer NOT NULL REFERENCES "users"("id"), "title" text NOT NULL, "created_at" timestamp NOT NULL DEFAULT now())`,
    `CREATE TABLE "comments" ("id" serial PRIMARY KEY, "post_id" integer NOT NULL REFERENCES "posts"("id"), "author_id" integer NOT NULL REFERENCES "users"("id"), "body" text NOT NULL)`,
    `INSERT INTO "users" ("name", "email") VALUES ('Ada', 'ada@example.com'), ('Grace', 'grace@example.com'), ('Linus', 'linus@example.com')`,
    `INSERT INTO "posts" ("author_id", "title") VALUES (1, 'Hello'), (2, 'Plans'), (1, 'Indexes')`,
    `INSERT INTO "comments" ("post_id", "author_id", "body") VALUES (1, 2, 'Nice'), (2, 1, 'Agreed')`,
  ],
  sqlite: [
    "CREATE TABLE `users` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `name` text NOT NULL, `email` text NOT NULL, `created_at` integer NOT NULL)",
    "CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`)",
    "CREATE TABLE `posts` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `author_id` integer NOT NULL REFERENCES `users`(`id`), `title` text NOT NULL, `created_at` integer NOT NULL)",
    "CREATE TABLE `comments` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `post_id` integer NOT NULL REFERENCES `posts`(`id`), `author_id` integer NOT NULL REFERENCES `users`(`id`), `body` text NOT NULL)",
    "INSERT INTO `users` (`name`, `email`, `created_at`) VALUES ('Ada', 'ada@example.com', 1), ('Grace', 'grace@example.com', 2), ('Linus', 'linus@example.com', 3)",
    "INSERT INTO `posts` (`author_id`, `title`, `created_at`) VALUES (1, 'Hello', 1), (2, 'Plans', 2), (1, 'Indexes', 3)",
    "INSERT INTO `comments` (`post_id`, `author_id`, `body`) VALUES (1, 2, 'Nice'), (2, 1, 'Agreed')",
  ],
} as const;

/** Drizzle property names of the blog schema's columns */
export const BLOG_KEYS: SchemaTableKeys[] = [
  { name: "users", columns: { id: "id", name: "name", email: "email", created_at: "createdAt" } },
  { name: "posts", columns: { id: "id", author_id: "authorId", title: "title", created_at: "createdAt" } },
  { name: "comments", columns: { id: "id", post_id: "postId", author_id: "authorId", body: "body" } },
];

/** What a run on that schema sends, as Drizzle writes it; `id` names each query in the tests. */
export const BLOG_QUERIES = [
  {
    id: "posts-by-author",
    sql: (p: Placeholder) => `select "id", "author_id", "title" from "posts" where "posts"."author_id" = ${p(1)}`,
    parameters: [1],
  },
  {
    id: "user-by-email",
    sql: (p: Placeholder) => `select "id", "name" from "users" where "users"."email" = ${p(1)}`,
    parameters: ["ada@example.com"],
  },
  {
    id: "latest-posts",
    sql: (p: Placeholder) => `select "id", "title" from "posts" order by "posts"."created_at" desc limit ${p(1)}`,
    parameters: [10],
  },
  { id: "count-posts", sql: () => `select count(*) from "posts"`, parameters: [] },
  {
    id: "posts-per-user",
    sql: () =>
      `select "users"."id", "users"."name", count("posts"."id") from "users" left join "posts" on "posts"."author_id" = "users"."id" group by "users"."id"`,
    parameters: [],
  },
  {
    id: "comments-by-author",
    sql: (p: Placeholder) =>
      `select "comments"."body", "posts"."title" from "comments" inner join "posts" on "posts"."id" = "comments"."post_id" where "comments"."author_id" = ${p(1)}`,
    parameters: [2],
  },
  {
    id: "insert-post",
    sql: (p: Placeholder) =>
      `insert into "posts" ("author_id", "title", "created_at") values (${p(1)}, ${p(2)}, ${p(3)}) returning "id"`,
    parameters: [1, "Planned", 4],
  },
  {
    id: "rename-user",
    sql: (p: Placeholder) => `update "users" set "name" = ${p(1)} where "users"."id" = ${p(2)}`,
    parameters: ["Ada L.", 1],
  },
  { id: "first-posts", sql: (p: Placeholder) => `select "id", "title" from "posts" limit ${p(1)}`, parameters: [5] },
] as const;

/** The id of one of `BLOG_QUERIES` */
export type BlogQueryId = (typeof BLOG_QUERIES)[number]["id"];

type Placeholder = (position: number) => string;

/** The run-phase SQL events a guest would report for the queries above. */
export function blogEvents(
  dialect: Dialect,
): Pick<SqlEvent, "sequence" | "phase" | "kind" | "outcome" | "sql" | "parameters">[] {
  const placeholder: Placeholder = dialect === "postgresql" ? (position) => `$${position}` : () => "?";

  return BLOG_QUERIES.map((query, index) => ({
    sequence: index + 10,
    phase: "run",
    kind: "executed",
    outcome: "succeeded",
    sql: query.sql(placeholder),
    parameters: query.parameters.map((value) => serializeValue(value)),
  }));
}
