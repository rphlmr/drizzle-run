import { db } from "@drizzle-run/runtime/context";

import { posts, users } from "./schema";

$.display("Users", await db.select().from(users));
$.display("Posts", await db.select().from(posts));
