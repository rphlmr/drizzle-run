import type { Dialect } from "@drizzle-run/core/catalog";
import { defineGuideManifest } from "@drizzle-run/core/guide";
import { defineRunManifest } from "@drizzle-run/core/manifest";

import { readExampleFiles } from "./example-files.ts";
import type { DrizzleRunGuideMeta, DrizzleRunStepMeta } from "./meta.ts";

const shiftingQuery =
  'import { db } from "@drizzle-run/runtime/context";\nimport { asc } from "drizzle-orm";\n\nimport { posts } from "./schema";\n\nconst first = await db.select().from(posts).orderBy(asc(posts.createdAt), asc(posts.id)).limit(2);\n$.display("First page before insert", first);\n\nawait db.insert(posts).values({ id: 7, title: "Earlier arrival", createdAt: "2025-12-31T09:00:00.000Z" });\nconst second = await db.select().from(posts).orderBy(asc(posts.createdAt), asc(posts.id)).limit(2).offset(2);\n$.display("Offset page after insert", second);\n';

const naiveQuery =
  'import { db } from "@drizzle-run/runtime/context";\nimport { asc, gt } from "drizzle-orm";\n\nimport { posts } from "./schema";\n\nconst first = await db.select().from(posts).orderBy(asc(posts.createdAt), asc(posts.id)).limit(2);\nconst last = first.at(-1);\n$.display("First page", first);\n\nif (last) {\n  const second = await db.select().from(posts)\n    .where(gt(posts.createdAt, last.createdAt))\n    .orderBy(asc(posts.createdAt), asc(posts.id)).limit(2);\n  $.display("Timestamp-only cursor skips a tie", second);\n}\n';

/** Teach the same pagination behavior using each dialect's timestamp storage. */
export function createPaginationGuide({ id, exampleId, dialect }: { id: string; exampleId: string; dialect: Dialect }) {
  const slug = `pagination-${dialect}`;
  const other = dialect === "postgresql" ? "sqlite" : "postgresql";
  const database = dialect === "postgresql" ? "PostgreSQL" : "SQLite";
  const storage =
    dialect === "postgresql"
      ? "PostgreSQL stores `createdAt` as `timestamptz`; string mode keeps the database timestamp available for the cursor."
      : "SQLite stores `createdAt` as text. This example writes fixed-width UTC ISO strings only, so text ordering follows time. Mixing offsets or formats would break that assumption.";

  return defineGuideManifest<DrizzleRunGuideMeta, DrizzleRunStepMeta>()({
    kind: "drizzle-run-guide",
    manifestVersion: 1,
    id,
    title: `Paginate with stable ordering (${database})`,
    description: "Compare offset pages with a composite cursor, handle tied timestamps, and fetch one extra row.",
    project: defineRunManifest({
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect },
      dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
      files: readExampleFiles(slug, ["schema.ts", "seed.ts", "query.ts", "pagination.ts"]),
      entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "query.ts" },
    }),
    steps: [
      {
        type: "walkthrough",
        id: "01-offset",
        label: "Numbered pages",
        title: "Give each row a stable position",
        body: `This guide uses ${database} and Drizzle ORM **1.0.0-rc.5**. Six posts include several tied timestamps. Sort by both \`createdAt\` and the unique \`id\`, then use \`limit\` and \`offset\`. Page numbers start at one, so the offset is \`(page - 1) * pageSize\`.\n\nPress **Run**. Pages contain IDs 1–2, 3–4 and 5–6. Ordering only by the timestamp would leave tied rows without a defined relative order. The schema includes a matching composite index.\n\n${storage}`,
        focus: { file: "query.ts", lines: [6, 15] },
        run: "required",
        highlight: { displays: ["Offset page 1", "Offset page 2", "Jump to page 3"] },
        links: [
          {
            label: "Limit and offset pagination",
            href: "https://orm.drizzle.team/docs/guides/limit-offset-pagination",
          },
        ],
        meta: {
          summary: "Use a unique tie-breaker before dividing rows into numbered pages.",
          changed: "Three pages return every seeded post once, in timestamp and ID order.",
        },
      },
      {
        type: "walkthrough",
        id: "02-shift",
        label: "Rows can shift",
        title: "Insert before the next offset page",
        body: "The first request reads IDs 1 and 2. Before the second request, an insert adds a post ahead of them in the sort order.\n\nPress **Run**. Offset 2 now returns IDs 2 and 3: ID 2 appears again because row positions moved. A unique order makes each query deterministic; it does not freeze the dataset between requests.\n\nEach Run starts from the seed again. This step simulates two requests and one intervening write within a single execution.",
        edits: [{ file: "query.ts", write: shiftingQuery }],
        focus: { file: "query.ts", lines: [6, 12] },
        run: "required",
        highlight: { displays: ["First page before insert", "Offset page after insert"] },
        meta: {
          summary: "See an offset page repeat a row after an earlier insert.",
          changed: "The second request repeats ID 2 after the insert shifts row positions.",
        },
      },
      {
        type: "walkthrough",
        id: "03-ties",
        label: "Cursor ties",
        title: "A timestamp alone skips tied rows",
        body: "A cursor describes where the previous page ended. The tempting filter is `createdAt > last.createdAt`.\n\nPress **Run**. The first page contains IDs 1 and 2, but ID 3 shares their timestamp. The timestamp-only filter jumps to IDs 4 and 5, skipping ID 3.\n\nThe cursor must describe the same complete ordering as the query. Here that means both the timestamp and the ID.",
        edits: [{ file: "query.ts", write: naiveQuery }],
        focus: { file: "query.ts", lines: [10, 14] },
        run: "required",
        highlight: { displays: ["First page", "Timestamp-only cursor skips a tie"] },
        meta: {
          summary: "Demonstrate why a cursor must include the unique tie-breaker.",
          changed: "ID 3 is skipped because its timestamp equals the last row of page one.",
        },
      },
      {
        type: "walkthrough",
        id: "04-composite",
        label: "Composite cursor",
        title: "Continue after the complete sort key",
        body: "Open `pagination.ts`. The filter keeps rows with a later timestamp, or the same timestamp and a larger ID. `Cursor` derives both field types from the table. The comparisons match the ascending order.\n\nThe helper fetches `pageSize + 1` rows. The extra row determines `hasNextPage`, but is not returned. The next cursor comes from the last **returned** row, so the extra row appears on the following page.\n\nPress **Run**. All six posts appear once, including the ties. The final page has `hasNextPage: false` and `nextCursor: null`. Validate positive page sizes and cursor values at your application's input boundary before calling a helper like this.",
        edits: [
          { file: "query.ts", write: readExampleFiles(`cursor-pagination-${dialect}`, ["query.ts"])["query.ts"] },
        ],
        focus: { file: "pagination.ts", lines: [6, 27] },
        run: "required",
        highlight: { displays: ["Cursor page 1", "Cursor page 2", "Cursor page 3"] },
        links: [{ label: "Cursor pagination", href: "https://orm.drizzle.team/docs/guides/cursor-based-pagination" }],
        meta: {
          summary: "Keep tied timestamps and compute hasNextPage from one extra row.",
          changed: "Pages return IDs 1–2, 3–4 and 5–6; the last page has no next cursor.",
        },
      },
      {
        type: "walkthrough",
        id: "05-starters",
        label: "Use the starters",
        title: "Choose numbered pages or sequential navigation",
        body: "Offset pagination lets you jump to a page number. Cursor pagination continues from a known sort key and can avoid scanning a growing offset when a suitable index is used. This small dataset demonstrates correctness, not a performance benchmark.\n\nA cursor is not a snapshot: deleting rows, changing sort keys or changing filters between requests still changes what you see. Reuse the same filters and ordering with a cursor. Descending order also needs the matching reversed comparisons.\n\nOpen either complete starter below to edit it without the deliberate mistakes from the guide.",
        run: "none",
        links: [
          { label: "Offset pagination starter", href: `/examples/offset-pagination-${dialect}` },
          { label: "Cursor pagination starter", href: `/examples/cursor-pagination-${dialect}` },
          { label: "The other database", href: `/examples/pagination-${other}` },
        ],
        meta: { summary: "Use the direct examples and keep cursor stability separate from snapshot guarantees." },
      },
    ],
    meta: { slug, status: "published", example: exampleId },
  });
}
