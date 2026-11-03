import { db } from "@drizzle-run/runtime/context";
import { and, eq, gte, sql } from "drizzle-orm";
import { products } from "./schema";

// Prepare once, then execute with different values. The sort order and selected columns stay fixed.
const searchProducts = db
  .select()
  .from(products)
  .where(
    and(eq(products.category, sql.placeholder("category")), gte(products.priceCents, sql.placeholder("minimumCents"))),
  )
  .orderBy(products.priceCents, products.id)
  .limit(sql.placeholder("pageSize"))
  .prepare("product_search");

// Validate external input before execute: these local values are already known.
$.display(
  "First book at or above 1000 cents",
  await searchProducts.execute({
    category: "books",
    minimumCents: 1000,
    pageSize: 1,
  }),
);
$.display(
  "Two books at or above 1000 cents",
  await searchProducts.execute({
    category: "books",
    minimumCents: 1000,
    pageSize: 2,
  }),
);
$.display(
  "Tools under the same query shape",
  await searchProducts.execute({
    category: "tools",
    minimumCents: 1000,
    pageSize: 2,
  }),
);
