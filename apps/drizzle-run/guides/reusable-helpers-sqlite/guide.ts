import { defineGuideManifest } from "@drizzle-run/core/guide";
import { defineRunManifest } from "@drizzle-run/core/manifest";

import { readExampleFiles } from "../example-files.ts";
import type { DrizzleRunGuideMeta, DrizzleRunStepMeta } from "../meta.ts";

const inferredQuery = `import { db } from "@drizzle-run/runtime/context";

import { jsonObject } from "./helpers";
import { users } from "./schema";

const profiles = await db.select({
  profile: jsonObject({
    id: users.id,
    displayName: users.name,
    bio: users.bio,
    active: users.active,
  }),
}).from(users).orderBy(users.id);

$.display("Profiles", profiles);
`;

const composedQuery = `import { db } from "@drizzle-run/runtime/context";
import { eq, sql } from "drizzle-orm";

import { jsonObject } from "./helpers";
import { posts, users } from "./schema";

const author = jsonObject({
  id: users.id,
  displayName: users.name,
  bio: users.bio,
  active: users.active,
});

const cards = await db.select({
  post: jsonObject({
    id: posts.id,
    title: posts.title,
    titleLength: sql<number>\`length(\${posts.title})\`,
    author,
  }),
}).from(posts)
  .innerJoin(users, eq(posts.authorId, users.id))
  .orderBy(posts.id);

const profiles = await db.select({ profile: author }).from(users).orderBy(users.id);

$.display("Post cards", cards);
$.display("Profiles", profiles);
`;

export const guide = defineGuideManifest<DrizzleRunGuideMeta, DrizzleRunStepMeta>()({
  kind: "drizzle-run-guide",
  manifestVersion: 1,
  id: "fe774193-38fd-49a1-82a6-e53211d7d948",
  title: "Write reusable, typed SQL helpers with SQLite",
  description: "Infer JSON object types from SQLite columns and compose expressions with runtime decoding.",
  project: defineRunManifest({
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "sqlite" },
    dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
    files: readExampleFiles("reusable-helpers-sqlite", ["schema.ts", "seed.ts", "query.ts", "helpers.ts"]),
    entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "query.ts" },
  }),
  steps: [
    {
      type: "walkthrough",
      id: "01-inline",
      label: "Start with SQL",
      title: "Build an object and decode the JSON text",
      body: "You want a profile with an ID, display name, nullable bio and active flag. This guide uses SQLite and Drizzle ORM **1.0.0-rc.5**. `json_object` builds the object as JSON text, and `.mapWith()` parses that text when Drizzle reads the selected expression.\n\nSQLite stores boolean-mode columns as integers. The `json(case ...)` expression turns those stored values into JSON booleans. The column's normal boolean decoder does not run inside `json_object`.\n\nPress **Run**. Ada has a bio and `active: true`; Grace has `bio: null` and `active: false`. `sql<string>` describes the JSON text before decoding; the parser's return type describes the decoded `Profile`. Parsing JSON does not validate its fields against that type.",
      focus: { file: "query.ts", lines: [14, 21] },
      run: "required",
      highlight: { displays: ["Profiles"] },
      links: [{ label: "SQL expressions and runtime mapping", href: "https://orm.drizzle.team/docs/sql" }],
      meta: {
        summary: "Build JSON in SQLite, preserve booleans and decode the selected text.",
        changed: "Two decoded profiles returned with booleans and Grace's null bio.",
      },
    },
    {
      type: "walkthrough",
      id: "02-infer",
      label: "Infer the result",
      title: "Move inference and decoding into one helper",
      body: "Replace the inline expression with `jsonObject({ ... })`, a custom helper in `helpers.ts`. It infers each result key, column type and nullable field from the argument. There is no separate `Profile` type at the call site.\n\nThe helper also handles the SQLite-specific work: constructing JSON, converting boolean-mode columns and parsing the selected JSON text. Hover over `profiles` to see `displayName: string`, `bio: string | null` and `active: boolean`.\n\nPress **Run**. The output stays the same. Rename `displayName` in the argument and the inferred result key follows your selection.",
      edits: [{ file: "query.ts", write: inferredQuery }],
      focus: { file: "query.ts", lines: [6, 13] },
      run: "required",
      highlight: { displays: ["Profiles"] },
      meta: {
        summary: "Infer the object type and reuse its JSON decoder without a handwritten result type.",
        changed: "The helper returned the same decoded profiles, including nullable text and booleans.",
      },
    },
    {
      type: "walkthrough",
      id: "03-compose",
      label: "Compose helpers",
      title: "Nest an expression and reuse it in another query",
      body: "`author` is an ordinary `SQL<T>` expression. The same helper nests it inside each post card and selects it on its own as a profile. A computed `length()` expression supplies `titleLength: number`.\n\nThe nested helper call stays a direct `json_object` expression in the generated SQL. SQLite recognizes it as JSON, so the author becomes an object rather than an escaped JSON string. The outer expression's decoder parses the whole result; nested `.mapWith()` decoders do not run independently.\n\nPress **Run**. You get three post cards and two profiles, with the same values as the PostgreSQL version. The inner join guarantees an author. This helper excludes columns from the nullable side of an outer join because the column's declared nullability does not describe that join.",
      edits: [{ file: "query.ts", write: composedQuery }],
      focus: { file: "query.ts", lines: [7, 28] },
      run: "required",
      highlight: { displays: ["Post cards", "Profiles"] },
      meta: {
        summary: "Compose nested JSON and a computed field, then reuse the author expression.",
        changed: "Three cards contain author objects; the same expression also returns two profiles.",
      },
    },
    {
      type: "walkthrough",
      id: "04-helper",
      label: "Read the helper",
      title: "Keep the SQLite representation explicit",
      body: "Open `helpers.ts`. `Shape` captures the argument's fields. `GetColumnData` keeps each column's type and nullability; `SQL<infer Value>` extracts a computed or nested expression's result type. JSON keys are bound parameters, and columns remain Drizzle SQL fragments.\n\nThe helper accepts built-in text, integer and boolean-mode columns. It explicitly converts boolean columns before JSON construction. Dates, blobs, JSON stored in text and custom column decoders need their own representation decisions. A typed SQL expression must also match its actual JSON output.\n\nSQLite treats ordinary text passed to `json_object` as a string, even when that text contains JSON. If you later read an object from a column or subquery and nest it again, wrap that value with SQLite's `json()` function. The direct nested helper calls in this guide already retain their JSON identity.\n\nFork the guide to keep the composed query and helper. [Open the PostgreSQL version](/examples/reusable-helpers) to compare the same lesson with `jsonb_build_object` and driver-decoded JSON.",
      focus: { file: "helpers.ts", lines: [27, 40] },
      run: "none",
      links: [
        { label: "Typed scalar helpers", href: "/examples/typed-scalar-helpers-sqlite" },
        { label: "Typed JSON aggregation", href: "/examples/typed-json-aggregation-sqlite" },
        { label: "Typed JSON filters", href: "/examples/typed-json-filters-sqlite" },
        { label: "SQL expressions and runtime mapping", href: "https://orm.drizzle.team/docs/sql" },
        { label: "The PostgreSQL version", href: "/examples/reusable-helpers" },
      ],
      meta: { summary: "Read the inferred type, boolean conversion and JSON text decoder." },
    },
  ],
  meta: { slug: "reusable-helpers-sqlite", status: "published", example: "6518a35e-d2f7-4489-9545-8989df9d7a16" },
});
