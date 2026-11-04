import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

type Attributes = { color?: string | null; sizes?: string[] };

export const products = sqliteTable("products", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  attributes: text("attributes", { mode: "json" }).$type<Attributes>().notNull(),
});
