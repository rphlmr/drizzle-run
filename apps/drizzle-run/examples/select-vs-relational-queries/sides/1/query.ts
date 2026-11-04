import { db } from "@drizzle-run/runtime/context";
import { asc, eq } from "drizzle-orm";

import { posts, users } from "./schema";

// One flat row per user and post. The left join keeps Linus, who has no posts, with a null title.
const rows = await db
  .select({ userId: users.id, name: users.name, title: posts.title })
  .from(users)
  .leftJoin(posts, eq(posts.authorId, users.id))
  .orderBy(asc(users.id), asc(posts.id));

$.display("Joined rows", rows);

// Nesting is up to you: group the rows by user.
const authors = new Map<number, { name: string; posts: { title: string }[] }>();

for (const row of rows) {
  const author = authors.get(row.userId) ?? { name: row.name, posts: [] };

  if (row.title !== null) {
    author.posts.push({ title: row.title });
  }

  authors.set(row.userId, author);
}

$.display("Authors with posts", [...authors.values()]);
