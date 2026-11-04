import { db } from "@drizzle-run/runtime/context";

import { products } from "./schema";

await db.insert(products).values([
  { id: 1, name: "SQL handbook", category: "books", priceCents: 2500 },
  { id: 2, name: "Pocket notes", category: "books", priceCents: 800 },
  { id: 3, name: "Query notebook", category: "books", priceCents: 1200 },
  { id: 4, name: "Debugging kit", category: "tools", priceCents: 4500 },
]);
