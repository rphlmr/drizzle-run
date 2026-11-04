import { defineGuideManifest } from "@drizzle-run/core/guide";
import { defineRunManifest } from "@drizzle-run/core/manifest";

import { readExampleFiles } from "../example-files.ts";
import type { DrizzleRunGuideMeta, DrizzleRunStepMeta } from "../meta.ts";

const inferredQuery = `import { db } from "@drizzle-run/runtime/context";

import { jsonbBuildObject } from "./helpers";
import { users } from "./schema";

const profiles = await db.select({
  profile: jsonbBuildObject({
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

import { jsonbBuildObject } from "./helpers";
import { posts, users } from "./schema";

const author = jsonbBuildObject({
  id: users.id,
  displayName: users.name,
  bio: users.bio,
  active: users.active,
});

const cards = await db.select({
  post: jsonbBuildObject({
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
  id: "9e829821-329e-4736-bda3-91ccbda402e5",
  title: "Write reusable, typed SQL helpers",
  description: "Infer a JSONB object's type from its inputs and compose it into ordinary Drizzle queries.",
  project: defineRunManifest({
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "postgresql" },
    dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
    files: readExampleFiles("reusable-helpers", ["schema.ts", "seed.ts", "query.ts", "helpers.ts"]),
    entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "query.ts" },
  }),
  steps: [
    {
      type: "walkthrough",
      id: "01-inline",
      label: "Start with SQL",
      title: "Return a JSONB object from a selection",
      body: "You want a profile object with an ID, a display name, a nullable bio and an active flag. PostgreSQL's `jsonb_build_object` builds it from key/value pairs. This guide uses Drizzle ORM **1.0.0-rc.5**.\n\nPress **Run**. Ada has a bio; Grace has `bio: null`. Both have a boolean `active` field. PostgreSQL builds the objects as part of the query.\n\n`sql<Profile>` tells TypeScript what comes back. You maintain that type separately from the SQL, so changing a field means keeping both in sync. It does not validate or convert the result at runtime.",
      focus: { file: "query.ts", lines: [6, 21] },
      run: "required",
      highlight: { displays: ["Profiles"] },
      links: [{ label: "SQL expressions and result types", href: "https://orm.drizzle.team/docs/sql" }],
      meta: {
        summary: "Start with a working SQL expression and a handwritten result type.",
        changed: "Two profiles returned, including Grace's null bio and false active flag.",
      },
    },
    {
      type: "walkthrough",
      id: "02-infer",
      label: "Infer the result",
      title: "Let the selected fields describe the type",
      body: "Replace the inline SQL with `jsonbBuildObject({ ... })`. This is a custom function in `helpers.ts`, built with Drizzle's `sql` template.\n\nThe helper infers each key and value from its argument. `displayName: users.name` becomes `displayName: string`, and `bio: users.bio` stays `bio: string | null`. There is no separate `Profile` type or type argument at the call site. Hover over `profiles` in the editor to inspect the result.\n\nPress **Run**. The output stays the same. Change `displayName` to `name` in the selection and the inferred result key changes with it.",
      edits: [{ file: "query.ts", write: inferredQuery }],
      focus: { file: "query.ts", lines: [6, 13] },
      run: "required",
      highlight: { displays: ["Profiles"] },
      meta: {
        summary: "Infer the result keys, scalar types and nullability from the helper's inputs.",
        changed: "The helper returned the same profiles without a handwritten Profile type.",
      },
    },
    {
      type: "walkthrough",
      id: "03-compose",
      label: "Compose helpers",
      title: "Nest the helper and reuse its expression",
      body: "A helper can return an ordinary `SQL<T>` expression. Here, `author` is reused in two selections: nested inside each post card and selected on its own as a profile. The helper has no database client or table name built into it.\n\nThe same function accepts post columns and a computed `sql<number>` field. The inferred post type includes `titleLength: number` and the complete nested author shape, including `bio: string | null`. The `sql<number>` annotation is your contract for PostgreSQL's `length()` result.\n\nPress **Run**. You get three post cards and two profiles. The inner join guarantees an author for each post. A helper cannot infer that an outer join makes a normally required column nullable, so this helper's contract excludes columns from the nullable side of an outer join.",
      edits: [{ file: "query.ts", write: composedQuery }],
      focus: { file: "query.ts", lines: [7, 28] },
      run: "required",
      highlight: { displays: ["Post cards", "Profiles"] },
      meta: {
        summary: "Compose nested objects and a computed field, then reuse the expression in another query.",
        changed: "Three post cards include typed author objects; the same author expression also returns two profiles.",
      },
    },
    {
      type: "walkthrough",
      id: "04-helper",
      label: "Read the helper",
      title: "Keep SQL construction and inference together",
      body: "Open `helpers.ts`. `Shape` captures the argument's exact fields. The mapped type visits each key: `GetColumnData` preserves a column's type and nullability, while `SQL<infer Value>` extracts a nested expression's result type. `sql.join` combines the key/value pairs into one expression.\n\nJSON keys are bound as text parameters, with `::text` giving PostgreSQL the parameter type. Columns stay Drizzle SQL fragments. No key or value is pasted into a raw SQL string.\n\nThis helper deliberately accepts built-in text, integer and boolean columns. PostgreSQL JSON construction does not run Drizzle's nested column decoders. Dates, bigint, numeric strings and custom types need an explicit JSON representation before you extend the helper. A nested SQL expression must also describe its actual JSON output; adding `sql<T>` or `.mapWith()` does not validate or decode fields inside the object.\n\nFork this guide to keep the composed query and helper in your own project. For ordered arrays and missing children, continue with [Build nested results with SQL](/examples/nested-sql-results).",
      focus: { file: "helpers.ts", lines: [14, 32] },
      run: "none",
      links: [
        { label: "The SQLite version", href: "/examples/reusable-helpers-sqlite" },
        { label: "Typed scalar helpers", href: "/examples/typed-scalar-helpers-postgresql" },
        { label: "Typed JSON aggregation", href: "/examples/typed-json-aggregation-postgresql" },
        { label: "Typed JSON filters", href: "/examples/typed-json-filters-postgresql" },
        { label: "Compose SQL expressions", href: "https://orm.drizzle.team/docs/sql" },
        { label: "Build nested arrays with SQL", href: "/examples/nested-sql-results" },
      ],
      meta: { summary: "Read the generic type, parameter binding and supported JSON representations." },
    },
  ],
  meta: { slug: "reusable-helpers", status: "published", example: "d031db96-2a77-4f97-a18e-b3ae93090ed6" },
});
