import { integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";

type Attributes = { color?: string | null; sizes?: string[] };

export const products = pgTable("products", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  attributes: jsonb("attributes").$type<Attributes>().notNull(),
});
