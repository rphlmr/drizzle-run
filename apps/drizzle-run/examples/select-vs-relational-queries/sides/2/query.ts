import { db } from "@drizzle-run/runtime/context";

// One call returns the nested result: each user with their posts, grouped by Drizzle from the relations.
// Linus has no posts, so his list is empty.
const authors = await db.query.users.findMany({
  columns: { name: true },
  with: {
    posts: {
      columns: { title: true },
      orderBy: { id: "asc" },
    },
  },
  orderBy: { id: "asc" },
});

$.display("Authors with posts", authors);
