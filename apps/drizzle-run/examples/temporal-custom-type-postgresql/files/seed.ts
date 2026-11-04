import { db } from "@drizzle-run/runtime/context";

import { bookings } from "./schema";

await db.insert(bookings).values([
  { id: 1, title: "Workshop", startsOn: "2024-02-28", followUp: null },
  { id: 2, title: "Leap-day session", startsOn: "2024-02-29", followUp: "2024-03-01" },
]);
