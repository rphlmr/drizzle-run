import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const products = sqliteTable("products", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  priceCents: integer("price_cents").notNull(),
  discountCents: integer("discount_cents").notNull(),
  restockThreshold: integer("restock_threshold"),
  stock: integer("stock").notNull().default(0),
}, (product) => [
  check("price_non_negative", sql`${product.priceCents} >= 0`),
  check("stock_non_negative", sql`${product.stock} >= 0`),
  check("discount_in_range", sql`${product.discountCents} >= 0 and ${product.discountCents} <= ${product.priceCents}`),
  check("threshold_non_negative", sql`${product.restockThreshold} >= 0`),
]);
