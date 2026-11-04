import { DIALECTS, type Dialect } from "@drizzle-run/core/catalog";
import { defineGuideManifest } from "@drizzle-run/core/guide";
import { defineRunManifest } from "@drizzle-run/core/manifest";

import { readExampleFiles } from "./example-files.ts";
import type { DrizzleRunGuideMeta, DrizzleRunStepMeta } from "./meta.ts";

/**
 * "First run", the guided first project the home starters open. Both dialects
 * share the steps; each starts from that dialect's quick start example, without walking it in the gallery.
 */
export function createFirstRunGuide(version: { id: string; slug: string }, dialect: Dialect, exampleFolder: string) {
  // The v1 docs serve PostgreSQL at the root and SQLite under /docs/sqlite.
  const docs = (page: string) => `https://orm.drizzle.team/docs/${DIALECTS[dialect].docsPathPrefix}${page}`;

  return defineGuideManifest<DrizzleRunGuideMeta, DrizzleRunStepMeta>()({
    kind: "drizzle-run-guide",
    manifestVersion: 1,
    id: version.id,
    title: "First run",
    description: "The project files, what Run does, and where results appear.",
    project: defineRunManifest({
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect },
      dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
      files: readExampleFiles(exampleFolder, ["schema.ts", "seed.ts", "query.ts"]),
      entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "query.ts" },
    }),
    steps: [
      {
        type: "walkthrough",
        id: "01-files",
        label: "Files",
        title: "The three project files",
        body: "`schema.ts` defines the tables, `seed.ts` inserts the data, and `query.ts` runs the queries. Each file has a tab above the editor.",
        focus: { file: "query.ts", lines: [5, 9] },
        run: "none",
        links: [{ label: "Schema declaration", href: docs("sql-schema-declaration") }],
        meta: { summary: "`schema.ts` defines tables, `seed.ts` inserts data, `query.ts` runs queries." },
      },
      {
        type: "walkthrough",
        id: "02-run",
        label: "Run",
        title: "Run the project",
        body: "Each run starts from a **fresh database**: it creates the tables from `schema.ts`, fills them with `seed.ts`, then runs `query.ts`.",
        focus: { file: "query.ts", lines: [5, 9] },
        run: "required",
        highlight: { displays: ["Users"] },
        links: [{ label: "Select", href: docs("select") }],
        meta: {
          summary: "The query returns the seeded users.",
          lineNotes: [{ file: "query.ts", match: "$.display(", text: "shows up in Results" }],
          changed: "Ada and Grace are inserted by `seed.ts`. Each `$.display` call in `query.ts` adds a result card.",
        },
      },
      {
        type: "walkthrough",
        id: "03-filter",
        label: "Filter",
        title: "Filter the users",
        body: "This step adds a `where` clause that keeps the users whose name starts with A. Press **Run** to compare the result.",
        edits: [
          {
            file: "query.ts",
            replace: {
              anchor: 'import { users } from "./schema";',
              with: 'import { like } from "drizzle-orm";\n\nimport { users } from "./schema";',
            },
          },
          {
            file: "query.ts",
            replace: {
              anchor: "await db.select().from(users);",
              with: 'await db.select().from(users).where(like(users.name, "A%"));',
            },
          },
        ],
        focus: { file: "query.ts", lines: [7, 7] },
        run: "required",
        highlight: { displays: ["Users"] },
        links: [{ label: "Operators", href: docs("operators") }],
        meta: {
          summary: "A `where` clause filters the users.",
          changed: "The `where` clause keeps the names that start with A, so Grace is no longer returned.",
        },
      },
    ],
    meta: { slug: version.slug, status: "published", mark: "run" },
  });
}
