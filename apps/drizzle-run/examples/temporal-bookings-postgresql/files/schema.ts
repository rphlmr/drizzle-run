import { integer, pgTable, text } from "drizzle-orm/pg-core";

import { plainDate } from "./temporal";

export const bookings = pgTable("bookings", {
  id: integer("id").primaryKey(),
  title: text("title").notNull(),
  startsOn: plainDate("starts_on").notNull(),
  followUp: plainDate("follow_up"),
});
