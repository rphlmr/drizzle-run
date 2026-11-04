import { db } from "@drizzle-run/runtime/context";
import { Temporal } from "@js-temporal/polyfill";

import { bookings } from "./schema";

await db.insert(bookings).values([
  { id: 1, title: "Workshop", startsOn: Temporal.PlainDate.from("2024-02-28"), followUp: null },
  { id: 2, title: "Leap-day session", startsOn: Temporal.PlainDate.from("2024-02-29"), followUp: Temporal.PlainDate.from("2024-03-01") },
]);
