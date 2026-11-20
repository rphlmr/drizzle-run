import { db } from "@drizzle-run/runtime/context";
import { inventory } from "./schema";

const result = await db.bulkInsert(inventory, [
  { warehouse: "north", sku: "cable", quantity: 24 },
  { warehouse: "south", sku: "adapter", quantity: 18, source: "manual" },
]);

$.display("Rows inserted", result.rowCount);
$.display("Inventory", await db.select().from(inventory).orderBy(inventory.warehouse, inventory.sku));
