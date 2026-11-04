import { defineGuideManifest } from "@drizzle-run/core/guide";
import { defineRunManifest } from "@drizzle-run/core/manifest";

import { readExampleFiles } from "../example-files.ts";
import type { DrizzleRunGuideMeta, DrizzleRunStepMeta } from "../meta.ts";

const docs = { label: "Transactions docs", href: "https://orm.drizzle.team/docs/transactions" };

export const guide = defineGuideManifest<DrizzleRunGuideMeta, DrizzleRunStepMeta>()({
  kind: "drizzle-run-guide",
  manifestVersion: 1,
  id: "db0755a7-fec9-4789-a9f7-d9314d0083cc",
  title: "Transactions keep all or nothing",
  description: "Transfer between accounts, roll back a savepoint, and check which writes are kept.",
  project: defineRunManifest({
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "postgresql" },
    dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
    files: readExampleFiles("transactions", ["schema.ts", "seed.ts", "query.ts"]),
    entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "query.ts" },
  }),
  steps: [
    {
      type: "walkthrough",
      id: "01-as-written",
      label: "As written",
      title: "Run the transfer",
      body: "Ada sends 30 to Grace inside `db.transaction`, so both updates commit together. A **savepoint** marks a point inside a transaction that you can roll back to.\n\nThe nested transaction throws, undoing its own update. The surrounding catch handles that error so the outer transaction can still commit the transfer.\n\nA separate transaction intentionally deletes every account, then rolls back. Press **Run**: Ada has 70 and Grace has 80.",
      focus: { file: "query.ts", lines: [7, 20] },
      run: "required",
      highlight: { displays: ["Balances"] },
      links: [docs],
      meta: {
        summary: "Move 30 from Ada to Grace, with a savepoint that fails.",
        changed: "Ada ended at 70, Grace at 80. The savepoint was rolled back.",
      },
    },
    {
      type: "walkthrough",
      id: "02-savepoint",
      label: "Savepoint",
      title: "Keep the savepoint's update",
      body: "The savepoint is undone because the nested transaction throws. This step removes that throw. Grace's balance is set to zero, and the savepoint is released.\n\nThat update is still part of the outer transaction: it is kept only when the outer transaction commits. Press **Run**: Ada has 70 and Grace has 0.",
      edits: [{ file: "query.ts", replace: { anchor: '      throw new Error("Changed our mind");\n', with: "" } }],
      focus: { file: "query.ts", lines: [13, 15] },
      run: "required",
      highlight: { displays: ["Balances"] },
      links: [docs],
      meta: {
        summary: "Without the throw, the savepoint's update is kept.",
        removed: "the throw",
        changed:
          "Without the error, the savepoint is **released** and its update is kept. Grace went from `80` to `0`.",
      },
    },
    {
      type: "walkthrough",
      id: "03-overdraft",
      label: "Overdraft",
      title: "Refuse an overdraft",
      body: "Ada has 70. This step tries to send 100 and calls `tx.rollback()` when her balance would go below zero, so the whole transfer is refused.",
      edits: [
        {
          file: "query.ts",
          replace: {
            anchor: '$.display("Balances", ',
            with: '// Ada can\'t send 100, so the whole transfer is refused.\ntry {\n  await db.transaction(async (tx) => {\n    const [ada] = await tx.update(accounts).set({ balance: sql`${accounts.balance} - 100` }).where(eq(accounts.owner, "Ada")).returning();\n    if (ada.balance < 0) tx.rollback();\n  });\n} catch {\n  console.log("Overdraft refused");\n}\n\n$.display("Balances", ',
          },
        },
      ],
      focus: { file: "query.ts", lines: [31, 39] },
      run: "required",
      highlight: { displays: ["Balances"] },
      links: [docs],
      meta: {
        summary: "Roll back when Ada would go below zero.",
        changed: "Sending 100 would leave Ada at −30, so `tx.rollback()` kept her at 70.",
      },
    },
  ],
  meta: {
    slug: "transactions",
    status: "published",
    example: "ee9bf870-ca60-4975-a7e3-f9e12000cb40",
    mark: "all or nothing",
  },
});
