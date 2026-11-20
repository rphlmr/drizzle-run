import { defineGuideManifest } from "@drizzle-run/core/guide";
import { defineRunManifest } from "@drizzle-run/core/manifest";

import { readExampleFiles } from "../example-files.ts";
import type { DrizzleRunGuideMeta, DrizzleRunStepMeta } from "../meta.ts";

const update = `import { db } from "@drizzle-run/runtime/context";
import { inventory } from "./schema";

const result = await db.bulkUpdate(
  inventory,
  [
    { warehouse: "north", sku: "keyboard", quantity: 15 },
    { warehouse: "north", sku: "mouse", quantity: 4 },
  ],
  { by: [inventory.warehouse, inventory.sku] },
);

$.display("Rows updated", result.rowCount);
$.display("Inventory", await db.select().from(inventory).orderBy(inventory.warehouse, inventory.sku));
`;

const chunkFailure = `import { db } from "@drizzle-run/runtime/context";
import { inventory } from "./schema";

const incoming = [
  { warehouse: "north", sku: "cable", quantity: 24 },
  { warehouse: "north", sku: "keyboard", quantity: 15 },
];

const readInventory = () => db.select().from(inventory).orderBy(inventory.warehouse, inventory.sku);

try {
  await db.bulkInsert(inventory, incoming, { chunk: 1 });
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "23505") throw error;
  $.display("Atomic import rejected", "North already stocks this keyboard");
}

$.display("Inventory after rollback", await readInventory());

try {
  await db.bulkInsert(inventory, incoming, { chunk: 1, atomic: false });
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "23505") throw error;
  $.display("Chunk rejected", "North already stocks this keyboard");
}

$.display("Inventory after partial commit", await readInventory());
`;

export const guide = defineGuideManifest<DrizzleRunGuideMeta, DrizzleRunStepMeta>()({
  kind: "drizzle-run-guide",
  manifestVersion: 1,
  id: "e1da88a4-584d-4738-9635-8af965248150",
  title: "Bulk insert and update",
  description: "Import inventory rows, update stock by warehouse and SKU, and see what commits when a chunk fails.",
  project: defineRunManifest({
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "postgresql" },
    dependencies: { "drizzle-orm": "1.0.0-rc.6", "drizzle-kit": "1.0.0-rc.6" },
    files: readExampleFiles("bulk-insert-and-update", ["schema.ts", "seed.ts", "query.ts"]),
    entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "query.ts" },
  }),
  steps: [
    {
      type: "walkthrough",
      id: "01-insert",
      label: "Bulk insert",
      title: "Import new stock from a supplier",
      body: "A shipment adds cables in the north warehouse and adapters in the south. With the Drizzle Postgres driver in **Drizzle ORM 1.0.0-rc.6**, pass both rows to `db.bulkInsert()`. The driver splits larger inputs into chunks and sends a multi-row `VALUES` statement per chunk. Drizzle Run uses the PGlite version of this driver.\n\nPress **Run**. The result reports two inserted rows via `rowCount`. The follow-up select shows where each row came from. Drizzle fills the cable's missing `source` with `$defaultFn()` and keeps the adapter's explicit `manual` value. PostgreSQL supplies the `received` status from the column default.",
      focus: { file: "query.ts", lines: [4, 7] },
      run: "required",
      highlight: { displays: ["Rows inserted", "Inventory"] },
      meta: { summary: "Insert two inventory rows and see how their defaults are filled." },
    },
    {
      type: "walkthrough",
      id: "02-update",
      label: "Bulk update",
      title: "Apply the latest stock counts",
      body: "Each step starts from the same seeded inventory. The north warehouse counted 15 keyboards and 4 mice. Both warehouses stock keyboards, so a SKU alone would also match the south warehouse. Pass both columns in `by` to match each row by warehouse and SKU. If one column identifies a row, pass that column directly.\n\nThe driver uses PostgreSQL's `unnest` to turn arrays of keys and values into rows for the update. Give each input all the key values and the same set of columns to update. Drizzle fills omitted values for columns with `$onUpdateFn()`.\n\nPress **Run**. Two rows change, their status becomes `recounted`, and the south warehouse still has 7 keyboards.",
      edits: [{ file: "query.ts", write: update }],
      focus: { file: "query.ts", lines: [4, 11] },
      run: "required",
      highlight: { displays: ["Rows updated", "Inventory"] },
      meta: { summary: "Update two stock counts by composite key and let Drizzle set the status." },
    },
    {
      type: "walkthrough",
      id: "03-chunk-failure",
      label: "Chunk failure",
      title: "See which rows survive a failed chunk",
      body: "The first row adds a cable. The second tries to insert a keyboard the north warehouse already stocks. This example sets `chunk: 1` so each row goes in its own statement.\n\nPress **Run**. By default, both bulk methods pipeline their chunks inside one transaction. The duplicate key rolls back the entire first call, including the cable insert. With `atomic: false`, each chunk commits on its own. The second call still throws on the keyboard, and the cable stays in inventory.\n\nIf you allow partial imports, account for already committed chunks before retrying. Replaying the same input here would hit a duplicate key on the cable.",
      edits: [{ file: "query.ts", write: chunkFailure }],
      focus: { file: "query.ts", lines: [11, 26] },
      run: "required",
      highlight: {
        displays: [
          "Atomic import rejected",
          "Inventory after rollback",
          "Chunk rejected",
          "Inventory after partial commit",
        ],
      },
      meta: { summary: "Compare a full rollback with a commit per chunk." },
    },
  ],
  meta: {
    slug: "bulk-insert-and-update",
    status: "published",
    example: "48704f21-06ce-4cdd-b261-89c5e3194513",
  },
});
