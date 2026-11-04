import { db } from "@drizzle-run/runtime/context";
import { gte } from "drizzle-orm";
import { Temporal } from "@js-temporal/polyfill";

import { bookings } from "./schema";

const rows = await db.select().from(bookings).orderBy(bookings.id);

// Display strings for readability; the selected values are real PlainDate objects.
$.display("Decoded dates", rows.map((row) => ({
  title: row.title,
  startsOn: row.startsOn.toString(),
  nextDay: row.startsOn.add({ days: 1 }).toString(),
  followUp: row.followUp?.toString() ?? null,
  isTemporal: row.startsOn instanceof Temporal.PlainDate,
})));

const leapDay = Temporal.PlainDate.from("2024-02-29");
await db.insert(bookings).values({ id: 3, title: "March session", startsOn: leapDay.add({ days: 1 }) });

const upcoming = await db.select().from(bookings)
  .where(gte(bookings.startsOn, leapDay)).orderBy(bookings.startsOn, bookings.id);

$.display("Bookings from leap day", upcoming.map((row) => ({
  title: row.title,
  startsOn: row.startsOn.toString(),
})));
