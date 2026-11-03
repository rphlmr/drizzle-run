import { integer, pgTable, text } from "drizzle-orm/pg-core";

export const products = pgTable("products", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  priceCents: integer("price_cents").notNull(),
});
