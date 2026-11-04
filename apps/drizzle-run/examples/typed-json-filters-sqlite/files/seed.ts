import { db } from "@drizzle-run/runtime/context";

import { products } from "./schema";

await db.insert(products).values([
  { id: 1, name: "Blue shirt", attributes: { color: "blue", sizes: ["S", "M"] } },
  { id: 2, name: "Blue coat", attributes: { color: "blue", sizes: ["L"] } },
  { id: 3, name: "Red shirt", attributes: { color: "red", sizes: ["M"] } },
  { id: 4, name: "Gift card", attributes: {} },
  { id: 5, name: "Uncoloured sample", attributes: { color: null } },
]);
