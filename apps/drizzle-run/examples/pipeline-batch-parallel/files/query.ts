import { db } from "@drizzle-run/runtime/context";
import { posts, users } from "./schema";

const [authors, drafts] = await db.pipeline([
  db.select().from(users).orderBy(users.id),
  db.select().from(posts).orderBy(posts.id),
]);

$.display("Authors", authors);
$.display("Drafts", drafts);
