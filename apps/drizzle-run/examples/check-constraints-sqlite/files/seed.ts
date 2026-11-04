import { db } from "@drizzle-run/runtime/context";

import { products } from "./schema";

await db.insert(products).values({ id: 1, name: "SQL handbook", priceCents: 2000, discountCents: 250 });
