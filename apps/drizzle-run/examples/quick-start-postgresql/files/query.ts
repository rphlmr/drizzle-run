import { db } from "@drizzle-run/runtime/context";

import { users } from "./schema";

const rows = await db.select().from(users);

console.log("Found", rows.length, "users");

$.display("Users", rows);
$.display("Summary", [{ total: rows.length }]);
