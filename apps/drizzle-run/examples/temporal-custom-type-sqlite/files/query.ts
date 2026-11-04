import { db } from "@drizzle-run/runtime/context";

import { bookings } from "./schema";

$.display("String dates", await db.select().from(bookings).orderBy(bookings.id));
