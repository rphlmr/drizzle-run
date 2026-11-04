import { readFileSync } from "node:fs";

import type { Dialect } from "@drizzle-run/core/catalog";
import { defineGuideManifest, type GuideEdit, type GuideStep } from "@drizzle-run/core/guide";
import { definePairManifest } from "@drizzle-run/core/pair";

import { readExampleFiles } from "./example-files.ts";
import type { DrizzleRunGuideMeta, DrizzleRunStepMeta } from "./meta.ts";
import { createPaginationGuide } from "./pagination-steps.ts";

const shiftingQuery = `import { db } from "@drizzle-run/runtime/context";

import { posts } from "./schema";

const first = await db.query.posts.findMany({ orderBy: { createdAt: "asc", id: "asc" }, limit: 2 });
$.display("First page before insert", first);

await db.insert(posts).values({ id: 7, title: "Earlier arrival", createdAt: "2025-12-31T09:00:00.000Z" });
const second = await db.query.posts.findMany({ orderBy: { createdAt: "asc", id: "asc" }, limit: 2, offset: 2 });
$.display("Offset page after insert", second);
`;

const naiveQuery = `import { db } from "@drizzle-run/runtime/context";

const first = await db.query.posts.findMany({ orderBy: { createdAt: "asc", id: "asc" }, limit: 2 });
const last = first.at(-1);
$.display("First page", first);

if (last) {
  const second = await db.query.posts.findMany({
    where: { createdAt: { gt: last.createdAt } },
    orderBy: { createdAt: "asc", id: "asc" },
    limit: 2,
  });
  $.display("Timestamp-only cursor skips a tie", second);
}
`;

/** Compare the same pagination rules through select and RQB on one database. */
export function createPaginationApiGuide({
  id,
  exampleId,
  dialect,
}: {
  id: string;
  exampleId: string;
  dialect: Dialect;
}) {
  const slug = `pagination-apis-${dialect}`;
  const base = createPaginationGuide({ id, exampleId, dialect });
  const run = {
    target: { dialect },
    dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
  } as const;
  function readSideFiles(side: 1 | 2) {
    return Object.fromEntries(
      ["query.ts", "pagination.ts"].map((file) => [
        file,
        readFileSync(new URL(`../examples/${slug}/sides/${side}/${file}`, import.meta.url), "utf8"),
      ]),
    );
  }

  const project = definePairManifest({
    kind: "drizzle-run-pair",
    manifestVersion: 1,
    entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "query.ts" },
    files: readExampleFiles(slug, ["schema.ts", "seed.ts"]),
    sides: [
      { ...run, name: "SQL-like", files: readSideFiles(1) },
      { ...run, name: "RQB", files: readSideFiles(2) },
    ],
  });
  const explanations: Record<string, string> = {
    "01-offset":
      "Compare both sides. SQL-like uses `orderBy`, `limit` and `offset` methods. RQB passes the same choices to `findMany`. Both databases start with the same seed in separate runs. The `relations` export registers `posts` for RQB even though this query loads no related tables.",
    "02-shift": "RQB repeats ID 2 too. Switching query APIs does not prevent an offset from moving after a write.",
    "03-ties":
      "On the RQB side, `where: { createdAt: { gt: last.createdAt } }` has the same missing tie-breaker. Both queries skip ID 3.",
    "04-composite":
      "Compare `pagination.ts` on both sides. RQB expresses the two branches with `OR`; the second branch matches both the timestamp and a larger ID. On the first page, `EmptyFilter` skips the filter. Import it from `drizzle-orm`: rc.5 rejects an explicitly undefined filter value. The query order and cursor fields are identical to the SQL-like version. Both helpers return the same page shape.",
    "05-starters":
      "Fork this comparison to keep both APIs. The starter links below open the SQL-like versions separately.",
  };

  return defineGuideManifest<DrizzleRunGuideMeta, DrizzleRunStepMeta>()({
    ...base,
    title: `Pagination: SQL-like vs RQB (${dialect === "sqlite" ? "SQLite" : "PostgreSQL"})`,
    description: "Run the same offset and composite-cursor queries through both Drizzle APIs.",
    project,
    steps: base.steps.map((step: GuideStep<DrizzleRunStepMeta>): GuideStep<DrizzleRunStepMeta> => {
      const edits: GuideEdit[] = (step.edits ?? []).map((edit) => ({ ...edit, side: 0 }));
      const rqbQuery =
        step.id === "02-shift"
          ? shiftingQuery
          : step.id === "03-ties"
            ? naiveQuery
            : step.id === "04-composite"
              ? readExampleFiles(`cursor-pagination-${dialect}`, ["query.ts"])["query.ts"]
              : undefined;

      if (rqbQuery !== undefined) {
        edits.push({ file: "query.ts", side: 1, write: rqbQuery });
      }

      return {
        ...step,
        body: `${step.body}\n\n${explanations[step.id]}`,
        ...(edits.length > 0 ? { edits } : {}),
        ...(step.focus ? { focus: { ...step.focus, side: 0 } } : {}),
      };
    }),
    meta: { slug, status: "published", example: exampleId },
  });
}
