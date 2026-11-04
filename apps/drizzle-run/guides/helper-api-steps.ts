import { readFileSync } from "node:fs";

import type { Dialect } from "@drizzle-run/core/catalog";
import { defineGuideManifest } from "@drizzle-run/core/guide";
import { definePairManifest, PAIR_SIDES } from "@drizzle-run/core/pair";

import { readExampleFiles } from "./example-files.ts";
import type { DrizzleRunGuideMeta, DrizzleRunStepMeta } from "./meta.ts";

/** Use the same typed SQL helper in a selection and RQB extras. */
export function createHelperApiGuide({ id, exampleId, dialect }: { id: string; exampleId: string; dialect: Dialect }) {
  const slug = `helper-apis-${dialect}`;
  const helper = dialect === "sqlite" ? "jsonObject" : "jsonbBuildObject";
  const queries = [1, 2].map((side) =>
    readFileSync(new URL(`../examples/${slug}/sides/${side}/query.ts`, import.meta.url), "utf8"),
  );
  const run = {
    target: { dialect },
    dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
  } as const;

  return defineGuideManifest<DrizzleRunGuideMeta, DrizzleRunStepMeta>()({
    kind: "drizzle-run-guide",
    manifestVersion: 1,
    id,
    title: `Typed helpers: SQL-like vs RQB (${dialect === "sqlite" ? "SQLite" : "PostgreSQL"})`,
    description: "Select typed JSON expressions with either API, then load nested author profiles.",
    project: definePairManifest({
      kind: "drizzle-run-pair",
      manifestVersion: 1,
      entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "query.ts" },
      files: readExampleFiles(slug, ["schema.ts", "seed.ts", "helpers.ts"]),
      sides: [
        { ...run, name: "SQL-like", files: { "query.ts": queries[0] } },
        { ...run, name: "RQB", files: { "query.ts": queries[1] } },
      ],
    }),
    steps: [
      {
        type: "walkthrough",
        id: "01-profiles",
        label: "Select a helper",
        title: "Use the same expression with either API",
        body: `You need a profile with an ID, display name, nullable bio and active flag. Both sides use Drizzle ORM **1.0.0-rc.5** and the same \`${helper}\` helper from \`helpers.ts\`.\n\nThe SQL-like query selects the expression as \`profile\`. RQB puts it in \`extras\` and uses \`columns: {}\` to leave out the table's ordinary fields. Build the expression from the callback's \`user\` columns so it follows RQB's table alias.\n\nPress **Run**. Both sides return the same two profiles, including Grace's null bio and false active flag. Hover over \`profiles\`: its fields use normal TypeScript types without a handwritten result interface.`,
        edits: PAIR_SIDES.map((side) => ({
          file: "query.ts",
          side,
          write: queries[side].slice(0, queries[side].indexOf("const cards")),
        })),
        focus: { file: "query.ts", side: 1, lines: [6, 12] },
        run: "required",
        highlight: { displays: ["Profiles"] },
        meta: {
          summary: "Select the same inferred JSON expression with select or RQB extras.",
          changed: "Both APIs return matching typed profiles.",
        },
      },
      {
        type: "walkthrough",
        id: "02-authors",
        label: "Include an author",
        title: "Combine extras with a related record",
        body: "Each post belongs to an author. The SQL-like side uses an inner join and selects a nested `author.profile`. RQB uses `with: { author: ... }` and builds the profile in that relation's `extras` callback. Each callback receives the columns for its own table alias.\n\nBoth queries add `titleLength` with a typed SQL expression. RQB assembles the author relation, while the helper builds the profile object inside it. The schema marks the relation as required because `authorId` is non-null and references an existing user.\n\nPress **Run**. Both sides return the same three post cards and two profiles. This example uses a scalar helper in `extras`; it does not put a grouped aggregate query there.",
        edits: PAIR_SIDES.map((side) => ({ file: "query.ts", side, write: queries[side] })),
        focus: { file: "query.ts", side: 1, lines: [16, 29] },
        run: "required",
        highlight: { displays: ["Profiles", "Post cards"] },
        meta: {
          summary: "Use relation-local extras and a computed field without losing inferred types.",
          changed: "Both APIs return the same nested author profiles and post fields.",
        },
      },
      {
        type: "walkthrough",
        id: "03-contract",
        label: "Read the contract",
        title: "Keep the helper's representation rules",
        body: `Open \`helpers.ts\`. The helper accepts built-in text, integer and boolean columns, plus JSON-compatible SQL expressions. Its type maps column data and nullability into a plain object. The \`& {}\` keeps that object expanded in editor hovers.\n\n${dialect === "sqlite" ? "SQLite needs explicit boolean conversion and a JSON text decoder. The helper's `.mapWith()` also runs when its expression is selected through RQB extras, including under the author relation." : "PostgreSQL returns the JSONB object through the driver. JSON construction does not run each nested column's decoder, so dates, bigint and custom types need an explicit representation."}\n\nA helper's \`SQL<T>\` type describes the result; it does not validate arbitrary JSON at runtime. Use \`with\` to load related records, and \`extras\` when a selected record needs a computed expression.`,
        focus: { file: "helpers.ts", lines: [13, 27] },
        run: "none",
        links: [
          {
            label: "Build the helper step by step",
            href: `/examples/${dialect === "sqlite" ? "reusable-helpers-sqlite" : "reusable-helpers"}`,
          },
          { label: "Relational queries", href: "https://orm.drizzle.team/docs/rqb" },
          {
            label: "The other database",
            href: `/examples/helper-apis-${dialect === "sqlite" ? "postgresql" : "sqlite"}`,
          },
        ],
        meta: { summary: "Keep JSON decoding and supported input types explicit in both APIs." },
      },
    ],
    meta: { slug, status: "published", example: exampleId },
  });
}
