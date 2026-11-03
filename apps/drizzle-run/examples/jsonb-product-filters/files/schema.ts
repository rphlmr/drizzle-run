import { integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";

// $type supplies TypeScript inference, not runtime validation of external input.
type Attributes = {
  color?: string | null;
  sizes?: string[];
  shipping?: { weightGrams: number };
};

export const products = pgTable("products", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  attributes: jsonb("attributes").$type<Attributes>().notNull().default({}),
});
