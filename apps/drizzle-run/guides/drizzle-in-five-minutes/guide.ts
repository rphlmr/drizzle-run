import { defineGuideManifest } from "@drizzle-run/core/guide";
import { defineRunManifest } from "@drizzle-run/core/manifest";

import { readExampleFiles } from "../example-files.ts";
import type { DrizzleRunGuideMeta, DrizzleRunStepMeta } from "../meta.ts";

const insertQuery = `import { db } from "@drizzle-run/runtime/context";
import { posts } from "./schema";

// PostgreSQL generates the id; .returning() includes it in the inserted row.
const published = await db
  .insert(posts)
  .values({ title: "Learning Drizzle", authorId: 1 })
  .returning();

$.display("Published post", published);
`;

const selectQuery = `import { desc, eq } from "drizzle-orm";
import { db } from "@drizzle-run/runtime/context";
import { posts } from "./schema";

// Higher ids come first; an id is not a publication date.
const adaPosts = await db
  .select({ id: posts.id, title: posts.title })
  .from(posts)
  .where(eq(posts.authorId, 1))
  .orderBy(desc(posts.id));

$.display("Ada's posts", adaPosts);
`;

const joinQuery = `import { asc, eq } from "drizzle-orm";
import { db } from "@drizzle-run/runtime/context";
import { posts, users } from "./schema";

// One row per user and post. Linus has no posts, so the left join keeps him with a null title.
const rows = await db
  .select({ name: users.name, title: posts.title })
  .from(users)
  .leftJoin(posts, eq(posts.authorId, users.id))
  .orderBy(asc(users.id), asc(posts.id));

$.display("Users with posts", rows);
`;

const relationsSchema = `import { defineRelations } from "drizzle-orm";
import { integer, pgTable, serial, text } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
});

export const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  authorId: integer("author_id")
    .notNull()
    .references(() => users.id),
});

// Relations are declared once for the whole schema and exported as \`relations\`.
export const relations = defineRelations({ users, posts }, (r) => ({
  users: {
    posts: r.many.posts(),
  },
  posts: {
    author: r.one.users({ from: r.posts.authorId, to: r.users.id }),
  },
}));
`;

const relationalQuery = `import { db } from "@drizzle-run/runtime/context";

// One call returns each user with their posts, nested by the relations in schema.ts.
const usersWithPosts = await db.query.users.findMany({
  columns: { name: true },
  with: {
    posts: { columns: { title: true }, orderBy: { id: "asc" } },
  },
  orderBy: { id: "asc" },
});

$.display("Users with posts", usersWithPosts);
`;

const updateQuery = `import { asc, eq } from "drizzle-orm";
import { db } from "@drizzle-run/runtime/context";
import { posts } from "./schema";

// Without .where(), an update or delete affects every row in the table.
const renamed = await db.update(posts).set({ title: "Hello, Drizzle" }).where(eq(posts.id, 1)).returning();
const deleted = await db.delete(posts).where(eq(posts.id, 3)).returning();

$.display("Renamed", renamed);
$.display("Deleted", deleted);
$.display("Posts", await db.select().from(posts).orderBy(asc(posts.id)));
`;

const transactionQuery = `import { asc, eq, TransactionRollbackError } from "drizzle-orm";
import { db } from "@drizzle-run/runtime/context";
import { posts } from "./schema";

// Roll back both changes, leaving the seeded posts untouched.
try {
  await db.transaction(async (tx) => {
    await tx.update(posts).set({ title: "Hello, Drizzle" }).where(eq(posts.id, 1));
    await tx.delete(posts).where(eq(posts.id, 3));
    tx.rollback();
  });
} catch (cause) {
  if (!(cause instanceof TransactionRollbackError)) {
    throw cause;
  }

  console.log("Rolled back: neither change was kept");
}

$.display("After rollback", await db.select().from(posts).orderBy(asc(posts.id)));

// The same changes, from the same starting rows, now commit together.
await db.transaction(async (tx) => {
  await tx.update(posts).set({ title: "Hello, Drizzle" }).where(eq(posts.id, 1));
  await tx.delete(posts).where(eq(posts.id, 3));
});

$.display("After commit", await db.select().from(posts).orderBy(asc(posts.id)));
`;

export const guide = defineGuideManifest<DrizzleRunGuideMeta, DrizzleRunStepMeta>()({
  kind: "drizzle-run-guide",
  manifestVersion: 1,
  id: "edbd813d-0182-442e-ae06-9881463dac85",
  title: "Drizzle in five minutes",
  description: "Create, read, update and delete posts, compare query shapes, then keep related writes together.",
  project: defineRunManifest({
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "postgresql" },
    dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
    files: readExampleFiles("drizzle-in-five-minutes", ["schema.ts", "seed.ts", "query.ts"]),
    entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "query.ts" },
    randomSeed: 42,
  }),
  steps: [
    {
      type: "walkthrough",
      id: "01-tables",
      label: "Tables",
      title: "Meet your tables",
      body: "You manage a small blog with Drizzle ORM **1.0.0-rc.5** on PostgreSQL. Drizzle Run provides the connection so you can focus on the API.\n\n`schema.ts` declares `users` and `posts` with `pgTable`. A **primary key** identifies each row. The post's `authorId` references `users.id`, so each post must point to an existing user.\n\nEvery **Run** starts fresh: create tables, run `seed.ts`, then run `query.ts`. Press **Run** to meet Ada, Grace and Linus.",
      focus: { file: "schema.ts", lines: [8, 14] },
      run: "required",
      highlight: { displays: ["Users", "Posts"] },
      links: [
        { label: "Schema declaration", href: "https://orm.drizzle.team/docs/sql-schema-declaration" },
        { label: "Foreign keys", href: "https://orm.drizzle.team/docs/indexes-constraints#foreign-key" },
      ],
      meta: { summary: "Three users and three posts, written by `seed.ts` before every run." },
    },
    {
      type: "walkthrough",
      id: "02-insert",
      label: "Insert",
      title: "Publish Ada's next post",
      body: "Use `.insert(posts).values()` to publish a post. You supply its title and Ada's user ID, `1`. The `serial` column generates the post ID.\n\n`.returning()` gives you an array of inserted rows, including generated values. Press **Run**: **Published post** contains one row with ID `4`.",
      edits: [{ file: "query.ts", write: insertQuery }],
      focus: { file: "query.ts", lines: [5, 8] },
      run: "required",
      highlight: { displays: ["Published post"] },
      links: [{ label: "Insert", href: "https://orm.drizzle.team/docs/insert" }],
      meta: {
        summary: "Supply a title and author; return the generated post ID.",
        changed: "You supplied the title and author. PostgreSQL generated ID `4` for Learning Drizzle.",
      },
    },
    {
      type: "walkthrough",
      id: "03-select",
      label: "Select",
      title: "Find Ada's posts",
      body: "Select just `id` and `title`. `.where(eq(posts.authorId, 1))` keeps Ada's posts; `.orderBy(desc(posts.id))` puts higher IDs first.\n\nThis step replaces the insert with a select. Each run starts from the seed, so the post you inserted in step 2 is gone. Press **Run**: you get Notes, then Hello. Open **SQL** to inspect the selected columns, filter and ordering.",
      edits: [{ file: "query.ts", write: selectQuery }],
      focus: { file: "query.ts", lines: [6, 10] },
      run: "required",
      highlight: { displays: ["Ada's posts"] },
      links: [
        { label: "Select", href: "https://orm.drizzle.team/docs/select" },
        { label: "Filters", href: "https://orm.drizzle.team/docs/operators" },
      ],
      meta: {
        summary: "Pick two columns, filter by author, and order by ID.",
        changed: "Only Ada's seeded posts remain: Notes (`2`), then Hello (`1`).",
      },
    },
    {
      type: "walkthrough",
      id: "04-relations",
      label: "Relations",
      title: "Load users with their posts",
      body: "On the **SQL-like** side, `leftJoin` matches `posts.authorId` to `users.id`. Choose this shape when you want flat rows: Ada appears once per post.\n\nThe **relational query builder (RQB)** returns each user with a nested posts array. `defineRelations` describes those connections for `db.query`; it does not replace the database's foreign key.\n\nPress **Run**. Linus has no posts: the left join keeps him with a `null` title, and RQB returns an empty posts array.",
      split: { sides: [{ name: "SQL-like" }, { name: "RQB" }], files: ["query.ts"] },
      edits: [
        { file: "schema.ts", write: relationsSchema },
        { file: "query.ts", side: 0, write: joinQuery },
        { file: "query.ts", side: 1, write: relationalQuery },
      ],
      focus: { file: "query.ts", side: 1, lines: [4, 10] },
      run: "required",
      highlight: { displays: ["Users with posts"] },
      links: [
        { label: "Joins", href: "https://orm.drizzle.team/docs/joins" },
        { label: "Relational queries", href: "https://orm.drizzle.team/docs/rqb" },
        { label: "Relations", href: "https://orm.drizzle.team/docs/relations-v2" },
      ],
      meta: {
        summary: "Compare flat joined rows with nested relational results.",
        changed: "Both sides keep Linus: a null title in the join, an empty posts array in RQB.",
      },
    },
    {
      type: "walkthrough",
      id: "05-update-delete",
      label: "Update",
      title: "Update and delete",
      body: "Back to one editor. `.update().set()` renames post `1`; `.delete()` removes post `3`. Each `.where()` selects a post by ID. `.returning()` gives back the changed rows.\n\n**Without .where(), an update or delete affects every row in the table.** In your own project, [Drizzle's ESLint plugin](https://orm.drizzle.team/docs/eslint-plugin) can flag missing filters. It cannot tell whether your filter selects the intended rows.\n\nPress **Run**: Hello becomes Hello, Drizzle; Ships is deleted; Notes stays.",
      merge: { keep: 0 },
      edits: [{ file: "query.ts", write: updateQuery }],
      focus: { file: "query.ts", lines: [6, 7] },
      run: "required",
      highlight: { displays: ["Renamed", "Deleted", "Posts"] },
      links: [
        { label: "Update", href: "https://orm.drizzle.team/docs/update" },
        { label: "Delete", href: "https://orm.drizzle.team/docs/delete" },
        { label: "ESLint safeguards", href: "https://orm.drizzle.team/docs/eslint-plugin" },
      ],
      meta: { summary: "Rename a post and delete another, with `.returning()`." },
    },
    {
      type: "walkthrough",
      id: "06-transaction",
      label: "Transaction",
      title: "Keep both changes or neither",
      body: "A **transaction** keeps a group of writes together: they all commit, or they are undone. Use `tx` for both writes inside `db.transaction`.\n\nThe first transaction renames Hello and deletes Ships, then calls `tx.rollback()`. That throws a rollback error, which we catch outside the transaction. Both changes are undone.\n\nThe second transaction repeats the same writes without rolling back. Press **Run**: **After rollback** has the original three posts; **After commit** has Hello, Drizzle and Notes.",
      edits: [{ file: "query.ts", write: transactionQuery }],
      focus: { file: "query.ts", lines: [7, 11] },
      run: "required",
      highlight: { displays: ["After commit", "After rollback"] },
      links: [
        { label: "Transactions", href: "https://orm.drizzle.team/docs/transactions" },
        { label: "Transactions and savepoints", href: "/examples/transactions" },
      ],
      meta: {
        summary: "Compare the same writes rolled back and committed.",
        changed: "Rollback kept all three original posts. Commit kept the rename and deletion together.",
      },
    },
    {
      type: "walkthrough",
      id: "07-practice",
      label: "Your turn",
      title: "Find Grace's posts yourself",
      body: "The editor is back to the filtered select, and the next run starts from the original seed. Choose **Finish guide** to unlock the editor.\n\nChange the author ID in `.where()` from `1` to `2`, change the display label to Grace's posts, then press **Run**. You should get one row: Ships, with ID `3`.\n\nUse **Fork to my projects** if you want to keep your changes. Next, explore [relational queries](https://orm.drizzle.team/docs/rqb) in more depth.",
      edits: [{ file: "query.ts", write: selectQuery }],
      focus: { file: "query.ts", lines: [9, 9] },
      run: "none",
      links: [{ label: "Relational queries", href: "https://orm.drizzle.team/docs/rqb" }],
      meta: {
        summary: "Finish the guide, filter by author ID `2`, and run. Expect Ships (`3`).",
        changed: "Your turn: filter by author ID `2` and run. Expect Ships (`3`). Fork to keep your changes.",
      },
    },
  ],
  meta: {
    slug: "drizzle-in-five-minutes",
    status: "published",
    example: "04545083-ced6-421c-8fd1-cb735e20dfb2",
    mark: "five minutes",
  },
});
