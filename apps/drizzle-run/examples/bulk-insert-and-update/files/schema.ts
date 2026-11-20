import { integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const inventory = pgTable(
  "inventory",
  {
    warehouse: text().notNull(),
    sku: text().notNull(),
    quantity: integer().notNull(),
    source: text().notNull().$defaultFn(() => "supplier"),
    status: text().notNull().default("received").$onUpdateFn(() => "recounted"),
  },
  (table) => [primaryKey({ columns: [table.warehouse, table.sku] })],
);
