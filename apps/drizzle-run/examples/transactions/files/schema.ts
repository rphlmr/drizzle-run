import { integer, pgTable, serial, text } from "drizzle-orm/pg-core";

export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  owner: text("owner").notNull(),
  balance: integer("balance").notNull(),
});
