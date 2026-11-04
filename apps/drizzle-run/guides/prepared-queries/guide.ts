import { defineGuideManifest } from "@drizzle-run/core/guide";
import { defineRunManifest } from "@drizzle-run/core/manifest";

import { readExampleFiles } from "../example-files.ts";
import type { DrizzleRunGuideMeta, DrizzleRunStepMeta } from "../meta.ts";

export const guide = defineGuideManifest<DrizzleRunGuideMeta, DrizzleRunStepMeta>()({
  kind: "drizzle-run-guide",
  manifestVersion: 1,
  id: "3fdbca4a-91c8-4956-b1a8-57bd40b3fef2",
  title: "Reuse queries with named placeholders",
  description: "Prepare a product search once and supply new filter values when you execute it.",
  project: defineRunManifest({
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "postgresql" },
    dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
    files: readExampleFiles("prepared-queries", ["schema.ts", "seed.ts", "query.ts"]),
    entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "query.ts" },
  }),
  steps: [
    {
      type: "walkthrough",
      id: "01-bound-values",
      focus: { file: "query.ts", lines: [7, 13] },
      label: "Bound values",
      title: "Pass a value to an ordinary query",
      body: "This guide uses PostgreSQL and Drizzle ORM **1.0.0-rc.5** to search a small product catalogue. Prices are stored as integer cents.\n\nStart with an ordinary query. `eq(products.category, category)` binds the category as a parameter. It does not paste the text into SQL. You do not need `.prepare()` to bind values safely.\n\nPress **Run**, then look at the SQL panel: the statement and its parameter values are separate. The result contains three books, ordered by price and then ID.",
      run: "required",
      highlight: {
        displays: ["Books"],
      },
      links: [
        {
          label: "Prepared queries and placeholders",
          href: "https://orm.drizzle.team/docs/perf-queries",
        },
      ],
      meta: {
        summary: "An ordinary Drizzle query already separates SQL from its values.",
        changed: "Pocket notes, Query notebook and SQL handbook returned in price order.",
      },
    },
    {
      type: "walkthrough",
      id: "02-prepare",
      focus: { file: "query.ts", lines: [6, 14] },
      label: "Prepare once",
      title: "Reuse a query with a named placeholder",
      body: 'A **placeholder** names a value you will provide later. `sql.placeholder("category")` leaves that value open, and `.prepare("products_by_category")` creates a reusable query object.\n\nCall `.execute({ category: ... })` with the same placeholder name. Press **Run**: the same prepared object searches books, then tools. The SQL shape stays the same while the value changes.\n\nThe prepare name identifies the statement; it is not the placeholder name. Keep a statement name associated with one query shape. Preparing does not cache the returned rows.',
      edits: [
        {
          file: "query.ts",
          write:
            'import { db } from "@drizzle-run/runtime/context";\nimport { eq, sql } from "drizzle-orm";\n\nimport { products } from "./schema";\n\nconst byCategory = db\n  .select()\n  .from(products)\n  .where(eq(products.category, sql.placeholder("category")))\n  .orderBy(products.priceCents, products.id)\n  .prepare("products_by_category");\n\n$.display("Books", await byCategory.execute({ category: "books" }));\n$.display("Tools", await byCategory.execute({ category: "tools" }));\n',
        },
      ],
      run: "required",
      highlight: {
        displays: ["Books", "Tools"],
      },
      links: [
        {
          label: "Prepared queries and placeholders",
          href: "https://orm.drizzle.team/docs/perf-queries",
        },
      ],
      meta: {
        summary: "Prepare once and supply category each time you execute.",
        changed: "One prepared query returned three books, then one tool.",
      },
    },
    {
      type: "walkthrough",
      id: "03-several-values",
      focus: { file: "query.ts", lines: [7, 15] },
      label: "Several values",
      title: "Bind a minimum price and a result limit",
      body: "Placeholders work for more than equality filters. This query binds `category`, `minimumCents` and the numeric `pageSize` passed to `limit`.\n\nPress **Run**. With a minimum of 1000 cents, Pocket notes is excluded. A limit of one returns Query notebook; a limit of two also returns SQL handbook. The tools call reuses that same query shape.\n\nPlaceholders stand for **values**, not table names, column names or sort directions. Here the order is fixed. If your application offers different sorts, choose the allowed columns and directions in query-building code.",
      edits: [
        {
          file: "query.ts",
          write:
            'import { db } from "@drizzle-run/runtime/context";\nimport { and, eq, gte, sql } from "drizzle-orm";\n\nimport { products } from "./schema";\n\n// Prepare once, then execute with different values. The sort order and selected columns stay fixed.\nconst searchProducts = db\n  .select()\n  .from(products)\n  .where(\n    and(eq(products.category, sql.placeholder("category")), gte(products.priceCents, sql.placeholder("minimumCents"))),\n  )\n  .orderBy(products.priceCents, products.id)\n  .limit(sql.placeholder("pageSize"))\n  .prepare("product_search");\n\n// Validate external input before execute: these local values are already known.\n$.display(\n  "First book at or above 1000 cents",\n  await searchProducts.execute({\n    category: "books",\n    minimumCents: 1000,\n    pageSize: 1,\n  }),\n);\n$.display(\n  "Two books at or above 1000 cents",\n  await searchProducts.execute({\n    category: "books",\n    minimumCents: 1000,\n    pageSize: 2,\n  }),\n);\n$.display(\n  "Tools under the same query shape",\n  await searchProducts.execute({\n    category: "tools",\n    minimumCents: 1000,\n    pageSize: 2,\n  }),\n);\n',
        },
      ],
      run: "required",
      highlight: {
        displays: ["First book at or above 1000 cents", "Two books at or above 1000 cents"],
      },
      links: [
        {
          label: "Prepared queries and placeholders",
          href: "https://orm.drizzle.team/docs/perf-queries",
        },
      ],
      meta: {
        summary: "Reuse the filters and limit with different execution values.",
        changed:
          "The one-row and two-row searches returned the expected books; the tools search returned Debugging kit.",
      },
    },
    {
      type: "walkthrough",
      id: "04-missing-value",
      focus: { file: "query.ts", lines: [43, 51] },
      label: "Missing value",
      title: "Provide every named placeholder",
      body: 'The final call deliberately leaves out `minimumCents`. The catch handles only the error this lesson expects and displays its message; any different error is rethrown.\n\nPress **Run**. Drizzle reports **No value for placeholder "minimumCents" was provided**. A missing value does not remove that filter.\n\nNamed placeholders are not input validation. Validate values from requests or forms before execution, including the category, minimum price and an allowed positive page size.',
      edits: [
        {
          file: "query.ts",
          write:
            'import { db } from "@drizzle-run/runtime/context";\nimport { and, eq, gte, sql } from "drizzle-orm";\n\nimport { products } from "./schema";\n\n// Prepare once, then execute with different values. The sort order and selected columns stay fixed.\nconst searchProducts = db\n  .select()\n  .from(products)\n  .where(\n    and(eq(products.category, sql.placeholder("category")), gte(products.priceCents, sql.placeholder("minimumCents"))),\n  )\n  .orderBy(products.priceCents, products.id)\n  .limit(sql.placeholder("pageSize"))\n  .prepare("product_search");\n\n// Validate external input before execute: these local values are already known.\n$.display(\n  "First book at or above 1000 cents",\n  await searchProducts.execute({\n    category: "books",\n    minimumCents: 1000,\n    pageSize: 1,\n  }),\n);\n$.display(\n  "Two books at or above 1000 cents",\n  await searchProducts.execute({\n    category: "books",\n    minimumCents: 1000,\n    pageSize: 2,\n  }),\n);\n$.display(\n  "Tools under the same query shape",\n  await searchProducts.execute({\n    category: "tools",\n    minimumCents: 1000,\n    pageSize: 2,\n  }),\n);\n\ntry {\n  await searchProducts.execute({ category: "books", pageSize: 2 });\n} catch (cause) {\n  if (!(cause instanceof Error) || cause.message !== \'No value for placeholder "minimumCents" was provided\') {\n    throw cause;\n  }\n\n  $.display("Missing placeholder", cause.message);\n}\n',
        },
      ],
      run: "required",
      highlight: {
        displays: ["Missing placeholder"],
      },
      links: [
        {
          label: "Prepared queries and placeholders",
          href: "https://orm.drizzle.team/docs/perf-queries",
        },
      ],
      meta: {
        summary: "See the exact error for an omitted value.",
        changed: "The missing minimumCents value was rejected before that query executed.",
      },
    },
    {
      type: "walkthrough",
      id: "05-reuse",
      label: "Use the starter",
      title: "Keep the prepared object where you reuse it",
      body: "Prepare once for repeated calls on the relevant database client, then execute with different values. Preparing inside each request or loop iteration would recreate the Drizzle query object each time.\n\nDrizzle Run recreates the playground for each Run, so the repeated calls here happen within one execution. This demonstrates the API, not a speed benchmark. Database-side preparation and plan reuse depend on the driver and connection or pool setup.\n\n[Open Prepared product search](/examples/prepared-product-search) for the complete editable starter, without the deliberate missing-value error.",
      run: "none",
      links: [
        {
          label: "Prepared queries and placeholders",
          href: "https://orm.drizzle.team/docs/perf-queries",
        },
        {
          label: "Fork the product search",
          href: "/examples/prepared-product-search",
        },
      ],
      meta: {
        summary: "Reuse the query object and keep driver-specific performance claims separate.",
      },
    },
  ],
  meta: { slug: "prepared-queries", status: "published", example: "41a44dd1-eeb7-4241-85fd-493b9f281a08" },
});
