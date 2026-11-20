import { db } from "@drizzle-run/runtime/context";
import { inventory } from "./schema";

await db.insert(inventory).values([
  { warehouse: "north", sku: "keyboard", quantity: 12 },
  { warehouse: "north", sku: "mouse", quantity: 9 },
  { warehouse: "south", sku: "keyboard", quantity: 7 },
]);
