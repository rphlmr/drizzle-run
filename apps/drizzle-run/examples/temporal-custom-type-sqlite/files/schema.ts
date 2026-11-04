import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const bookings = sqliteTable("bookings", {
  id: integer("id").primaryKey(),
  title: text("title").notNull(),
  startsOn: text("starts_on").notNull(),
  followUp: text("follow_up"),
});
