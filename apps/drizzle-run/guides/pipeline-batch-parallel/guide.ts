import { defineGuideManifest } from "@drizzle-run/core/guide";
import { defineRunManifest } from "@drizzle-run/core/manifest";

import { readExampleFiles } from "../example-files.ts";
import type { DrizzleRunGuideMeta, DrizzleRunStepMeta } from "../meta.ts";

function query(body: string) {
  return `import { db } from "@drizzle-run/runtime/context";
import { posts, users } from "./schema";

${body}
`;
}

const batch = query(`const [author, draft] = await db.batch([
  db.insert(users).values({ id: 2, name: "Grace" }).returning(),
  db.insert(posts).values({ id: 2, authorId: 2, title: "A second draft" }).returning(),
]);

$.display("Saved together", { author, draft });`);

const rollback = query(`try {
  await db.batch([
    db.insert(users).values({ id: 2, name: "Grace" }).returning(),
    db.insert(posts).values({ id: 1, authorId: 2, title: "A second draft" }).returning(),
  ]);
} catch (error) {
  const cause = error instanceof Error ? error.cause : undefined;
  if (!cause || typeof cause !== "object" || !("code" in cause) || cause.code !== "23505") throw error;
  $.display("Batch rejected", "The draft ID already exists");
}

$.display("Authors after rollback", await db.select().from(users).orderBy(users.id));`);

const parallel = query(`const [authors, drafts] = await db.parallel([
  db.select().from(users).orderBy(users.id),
  db.select().from(posts).orderBy(posts.id),
]);

$.display("Authors", authors);
$.display("Drafts", drafts);`);

const partialFailure = `import { db } from "@drizzle-run/runtime/context";
import { posts } from "./schema";

const duplicateDraft = () => db.insert(posts).values({ id: 1, authorId: 1, title: "A second draft" });
const loadDrafts = () => db.select().from(posts).orderBy(posts.id);

const pipeline = await db.pipeline([duplicateDraft(), loadDrafts()]);
const parallel = await db.parallel([duplicateDraft(), loadDrafts()]);

function showResults(label: string, results: readonly PromiseSettledResult<unknown>[]) {
  $.display(label, results.map((result) =>
    result.status === "fulfilled" ? result : { status: result.status, reason: String(result.reason) }
  ));
}

showResults("Pipeline results", pipeline);
showResults("Parallel results", parallel);
`;

export const guide = defineGuideManifest<DrizzleRunGuideMeta, DrizzleRunStepMeta>()({
  kind: "drizzle-run-guide",
  manifestVersion: 1,
  id: "64b5aa75-5854-4398-b2d6-1262ff68c5e2",
  title: "Pipeline, batch, and parallel",
  description: "Load authors and drafts with independent reads, then save an author and draft in one transaction.",
  project: defineRunManifest({
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "postgresql" },
    dependencies: { "drizzle-orm": "1.0.0-rc.6", "drizzle-kit": "1.0.0-rc.6" },
    files: readExampleFiles("pipeline-batch-parallel", ["schema.ts", "seed.ts", "query.ts"]),
    entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "query.ts" },
  }),
  steps: [
    {
      type: "walkthrough",
      id: "01-pipeline",
      label: "Pipeline",
      title: "Send both reads on one connection",
      body: "A drafts screen needs two lists, its authors and their drafts. With Drizzle ORM **1.0.0-rc.6**, `db.pipeline()` sends both selects back-to-back on one connection without waiting for the first result. Each query runs in its own transaction.\n\nPress **Run**. Each result has a `status` and either a `value` or a `reason`. The results follow the input order.",
      focus: { file: "query.ts", lines: [4, 7] },
      run: "required",
      highlight: { displays: ["Authors", "Drafts"] },
      meta: { summary: "Two result sets from queries sent on the same connection." },
    },
    {
      type: "walkthrough",
      id: "02-batch",
      label: "Batch",
      title: "Save the author and draft together",
      body: "Grace is a new author. We already know her ID, so we can build both inserts before sending them. `db.batch()` sends them in order inside one transaction. The post can reference the author inserted by the first statement.\n\nPress **Run** to see both rows from `.returning()`. If you need to read a generated ID in JavaScript before building the second query, use an interactive `db.transaction()` for that flow.",
      edits: [{ file: "query.ts", write: batch }],
      focus: { file: "query.ts", lines: [4, 7] },
      run: "required",
      highlight: { displays: ["Saved together"] },
      meta: { summary: "One transaction inserts both rows and returns both results." },
    },
    {
      type: "walkthrough",
      id: "03-rollback",
      label: "Rollback",
      title: "Check what happens when the second insert fails",
      body: "This time the new draft tries to reuse ID 1. PostgreSQL rejects it. The batch throws, and the transaction rolls back Grace's insert too.\n\nPress **Run**. The follow-up select shows only Ada, even though Grace's insert was first in the batch.",
      edits: [{ file: "query.ts", write: rollback }],
      focus: { file: "query.ts", lines: [5, 8] },
      run: "required",
      highlight: { displays: ["Batch rejected", "Authors after rollback"] },
      meta: { summary: "A duplicate draft ID rolls back both inserts." },
    },
    {
      type: "walkthrough",
      id: "04-parallel",
      label: "Parallel",
      title: "Let the pool run independent reads concurrently",
      body: "The same two reads can also use `db.parallel()`. It uses available pooled connections, and returns one settled result per query in input order. Use it when the queries can run independently.\n\nPress **Run** to see the same two lists. Drizzle Run uses local PGlite, which serializes engine work. On a PostgreSQL server, how much can run at once depends on the connections available to the pool.",
      edits: [{ file: "query.ts", write: parallel }],
      focus: { file: "query.ts", lines: [4, 7] },
      run: "required",
      highlight: { displays: ["Authors", "Drafts"] },
      meta: { summary: "The pool dispatches each independent query and reports its outcome." },
    },
    {
      type: "walkthrough",
      id: "05-partial-failure",
      label: "Partial failure",
      title: "Keep the result of the query that succeeds",
      body: "Run the same two statements through `db.pipeline()` and `db.parallel()`. The first tries to insert a draft with ID 1 again. The second loads the drafts.\n\nIn both groups, the insert returns `{ status: 'rejected', reason }` and the select returns `{ status: 'fulfilled', value }`. The call resolves with both outcomes in input order. Check each `status` before reading its `value` or `reason`.\n\nEach statement runs independently, so a successful write can still commit when another statement fails. Use `db.batch()` when all the writes need to succeed together.",
      edits: [{ file: "query.ts", write: partialFailure }],
      focus: { file: "query.ts", lines: [4, 8] },
      run: "required",
      highlight: { displays: ["Pipeline results", "Parallel results"] },
      meta: { summary: "Both methods report the failed insert and still return the drafts." },
    },
  ],
  meta: { slug: "pipeline-batch-parallel", status: "published", example: "3b9c3abc-1127-449a-b2f4-b61799ff1164" },
});
