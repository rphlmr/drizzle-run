import { Temporal } from "@js-temporal/polyfill";
import { customType } from "drizzle-orm/sqlite-core";

/** Store ISO-calendar PlainDate values with years 0001-9999; preserve SQL null through column nullability. */
export const plainDate = customType<{
  data: Temporal.PlainDate;
  driverData: string;
}>({
  dataType() {
    return "text";
  },
  codec: "text",
  toDriver(value) {
    if (value.calendarId !== "iso8601" || value.year < 1 || value.year > 9999) {
      throw new RangeError("This column stores ISO-calendar dates with years 0001-9999");
    }

    return value.toString();
  },
  fromDriver(value) {
    return Temporal.PlainDate.from(value);
  },
});
