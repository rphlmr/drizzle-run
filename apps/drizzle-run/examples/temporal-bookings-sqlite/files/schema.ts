import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { plainDate } from "./temporal";

export const bookings = sqliteTable("bookings", {
  id: integer("id").primaryKey(),
  title: text("title").notNull(),
  startsOn: plainDate("starts_on").notNull(),
  followUp: plainDate("follow_up"),
});
