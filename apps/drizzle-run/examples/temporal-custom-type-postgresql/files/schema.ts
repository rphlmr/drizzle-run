import { date, integer, pgTable, text } from "drizzle-orm/pg-core";

export const bookings = pgTable("bookings", {
  id: integer("id").primaryKey(),
  title: text("title").notNull(),
  startsOn: date("starts_on", { mode: "string" }).notNull(),
  followUp: date("follow_up", { mode: "string" }),
});
