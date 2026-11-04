import { defineGuideManifest } from "@drizzle-run/core/guide";
import { defineRunManifest } from "@drizzle-run/core/manifest";

import { readExampleFiles } from "../example-files.ts";
import type { DrizzleRunGuideMeta, DrizzleRunStepMeta } from "../meta.ts";

export const guide = defineGuideManifest<DrizzleRunGuideMeta, DrizzleRunStepMeta>()({
  kind: "drizzle-run-guide",
  manifestVersion: 1,
  id: "db5f37ed-322d-435e-94ef-6082a52bd47d",
  title: "Choose which rows a join keeps",
  description: "Compare inner, left, right, full and cross joins, and see why ON and WHERE differ.",
  project: defineRunManifest({
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "postgresql" },
    dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
    files: readExampleFiles("joins-explained", ["schema.ts", "seed.ts", "query.ts"]),
    entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "query.ts" },
  }),
  steps: [
    {
      type: "walkthrough",
      id: "01-inner",
      label: "Inner join",
      title: "Keep rows that match",
      body: "A **join** combines rows from two sources. Its `ON` condition decides which pairs match. Here, a book matches an author when `books.authorId` equals `authors.id`.\n\nThis guide runs on PostgreSQL with Drizzle ORM **1.0.0-rc.5**. Ada has two books, Grace has one, Linus has none, and Anonymous tale has no author. You can inspect them in `seed.ts`.\n\nPress **Run**. An `innerJoin` returns only matching pairs. Ada appears twice because she has two books. Linus and Anonymous tale do not appear.",
      focus: { file: "query.ts", lines: [6, 10] },
      run: "required",
      highlight: {
        displays: ["Matching authors and books"],
      },
      links: [
        {
          label: "Joins reference",
          href: "https://orm.drizzle.team/docs/joins",
        },
      ],
      meta: {
        summary: "Keep rows that match.",
        changed: "Three matching pairs returned: two for Ada and one for Grace.",
      },
    },
    {
      type: "walkthrough",
      id: "02-left",
      label: "Left join",
      title: "Keep every author",
      body: "In `.from(authors).leftJoin(books, ...)`, authors is the **left side**. A left join keeps every author, including one without a matching book.\n\nPress **Run**. Linus appears with `title: null`. Anonymous tale still does not appear because the query preserves authors, not unmatched books.\n\nThe selected title is nullable even though `books.title` is not nullable in the schema. Here null means there was no matching book row.",
      edits: [
        {
          file: "query.ts",
          write:
            'import { db } from "@drizzle-run/runtime/context";\nimport { and, eq } from "drizzle-orm";\n\nimport { authors, books } from "./schema";\n\nconst rows = await db\n  .select({ author: authors.name, title: books.title })\n  .from(authors)\n  .leftJoin(books, eq(books.authorId, authors.id))\n  .orderBy(authors.id, books.id);\n\n$.display("Every author", rows);\n',
        },
      ],
      focus: { file: "query.ts", lines: [6, 10] },
      run: "required",
      highlight: {
        displays: ["Every author"],
      },
      links: [
        {
          label: "Joins reference",
          href: "https://orm.drizzle.team/docs/joins",
        },
      ],
      meta: {
        summary: "Keep every author.",
        changed: "Four rows returned. Linus is present with a null title.",
      },
    },
    {
      type: "walkthrough",
      id: "03-where",
      label: "WHERE filter",
      title: "See which authors a WHERE filter removes",
      body: "This query adds `.where(eq(books.published, true))` after the left join. **WHERE filters the resulting rows.**\n\nPress **Run**. Only Ada's published book remains. Grace has only an unpublished book. Linus has a null book side, and null is not true, so he is removed too.\n\nA left join does not guarantee that every author survives a later WHERE condition.",
      edits: [
        {
          file: "query.ts",
          write:
            'import { db } from "@drizzle-run/runtime/context";\nimport { and, eq } from "drizzle-orm";\n\nimport { authors, books } from "./schema";\n\nconst rows = await db\n  .select({ author: authors.name, title: books.title })\n  .from(authors)\n  .leftJoin(books, eq(books.authorId, authors.id))\n  .where(eq(books.published, true))\n  .orderBy(authors.id, books.id);\n\n$.display("Published books, filtered after the join", rows);\n',
        },
      ],
      focus: { file: "query.ts", lines: [6, 11] },
      run: "required",
      highlight: {
        displays: ["Published books, filtered after the join"],
      },
      links: [
        {
          label: "Joins reference",
          href: "https://orm.drizzle.team/docs/joins",
        },
      ],
      meta: {
        summary: "See which authors a WHERE filter removes.",
        changed: "Only Ada with Types in practice remains.",
      },
    },
    {
      type: "walkthrough",
      id: "04-on",
      label: "ON filter",
      title: "Keep authors while filtering their matching books",
      body: "Move the published condition into `ON`, alongside the author ID match. It now decides which books can join to each author; the left join still preserves the authors.\n\nPress **Run**. Ada has her published book. Grace and Linus remain with null titles, because neither has a matching published book.\n\nUse `ON` to restrict the matches while retaining the left side. Use `WHERE` when you want to discard result rows that fail the filter.",
      edits: [
        {
          file: "query.ts",
          write:
            'import { db } from "@drizzle-run/runtime/context";\nimport { and, eq } from "drizzle-orm";\n\nimport { authors, books } from "./schema";\n\nconst rows = await db\n  .select({ author: authors.name, title: books.title })\n  .from(authors)\n  .leftJoin(books, and(eq(books.authorId, authors.id), eq(books.published, true)))\n  .orderBy(authors.id, books.id);\n\n$.display("Every author, with published books", rows);\n',
        },
      ],
      focus: { file: "query.ts", lines: [6, 10] },
      run: "required",
      highlight: {
        displays: ["Every author, with published books"],
      },
      links: [
        {
          label: "Joins reference",
          href: "https://orm.drizzle.team/docs/joins",
        },
      ],
      meta: {
        summary: "Keep authors while filtering their matching books.",
        changed: "Ada, Grace and Linus all remain; only Ada has a matching published title.",
      },
    },
    {
      type: "walkthrough",
      id: "05-outer",
      label: "Right and full",
      title: "Keep books or keep both sides",
      body: "A `rightJoin` preserves the **right side**, books. Press **Run**: Anonymous tale appears with a null author, while Linus is absent. You can also express this by starting from books and left-joining authors.\n\nA `fullJoin` preserves unmatched rows from **both sides**. The second result includes Linus and Anonymous tale, with nulls on their missing sides.\n\nMatched pairs still appear once per match. A full join does not produce every possible pair.",
      edits: [
        {
          file: "query.ts",
          write:
            'import { db } from "@drizzle-run/runtime/context";\nimport { and, eq } from "drizzle-orm";\n\nimport { authors, books } from "./schema";\n\nconst everyBook = await db\n  .select({ author: authors.name, title: books.title })\n  .from(authors)\n  .rightJoin(books, eq(books.authorId, authors.id))\n  .orderBy(authors.id, books.id);\n\n$.display("Right join keeps every book", everyBook);\n\nconst bothSides = await db\n  .select({ author: authors.name, title: books.title })\n  .from(authors)\n  .fullJoin(books, eq(books.authorId, authors.id))\n  .orderBy(authors.id, books.id);\n\n$.display("Full join keeps both sides", bothSides);\n',
        },
      ],
      focus: { file: "query.ts", lines: [6, 18] },
      run: "required",
      highlight: {
        displays: ["Right join keeps every book", "Full join keeps both sides"],
      },
      links: [
        {
          label: "Joins reference",
          href: "https://orm.drizzle.team/docs/joins",
        },
      ],
      meta: {
        summary: "Keep books or keep both sides.",
        changed: "The right join returned four rows. The full join returned five, keeping both unmatched records.",
      },
    },
    {
      type: "walkthrough",
      id: "06-cross",
      label: "Cross join",
      title: "Pair every author with every book",
      body: "A **cross join** has no matching condition. It combines every author with every book: three authors times four books gives twelve pairs.\n\nPress **Run**. These are combinations, not authorship claims. Linus is paired with all four books, even though he wrote none of them.\n\nUse a cross join when you deliberately need every combination, such as every size and colour. It is not a replacement for joining related records.",
      edits: [
        {
          file: "query.ts",
          write:
            'import { db } from "@drizzle-run/runtime/context";\nimport { and, eq } from "drizzle-orm";\n\nimport { authors, books } from "./schema";\n\nconst rows = await db\n  .select({ author: authors.name, title: books.title })\n  .from(authors)\n  .crossJoin(books)\n  .orderBy(authors.id, books.id);\n\n$.display("Every possible author and book pair", rows);\n',
        },
      ],
      focus: { file: "query.ts", lines: [6, 10] },
      run: "required",
      highlight: {
        displays: ["Every possible author and book pair"],
      },
      links: [
        {
          label: "Joins reference",
          href: "https://orm.drizzle.team/docs/joins",
        },
      ],
      meta: {
        summary: "Pair every author with every book.",
        changed: "Twelve combinations returned, including four for Linus.",
      },
    },
    {
      type: "walkthrough",
      id: "07-choose",
      label: "Choose a join",
      title: "Start with the rows you must keep",
      body: "Use **inner** when a matching row is required. Use **left** when every row from your starting table must remain. Use **right** to preserve the other side, or swap the starting table and use left. Use **full** to preserve unmatched rows on both sides. Use **cross** for every combination.\n\nThen decide which conditions belong in `ON` and which should filter the result in `WHERE`. More than one matching child still means more than one row.\n\nFor a practical starter, open [Filters, joins, and counts](/examples/filters-and-joins). To build nested arrays from multiple collections, continue with [Build nested results with SQL](/examples/nested-sql-results).",
      run: "none",
      links: [
        {
          label: "Joins reference",
          href: "https://orm.drizzle.team/docs/joins",
        },
        {
          label: "Open a joins starter",
          href: "/examples/filters-and-joins",
        },
        {
          label: "Build nested results",
          href: "/examples/nested-sql-results",
        },
      ],
      meta: {
        summary: "Choose the join by the rows your result must preserve.",
      },
    },
  ],
  meta: { slug: "joins-explained", status: "published", example: "c6e643b3-0bd2-4418-aa66-84b46f8c4239" },
});
