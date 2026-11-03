import { db } from "@drizzle-run/runtime/context";

// One call returns nested objects: each user with their posts, and each post with its comments.
const authors = await db.query.users.findMany({
  columns: { name: true },
  with: {
    posts: {
      columns: { title: true },
      orderBy: { id: "asc" },
      with: {
        comments: {
          columns: { body: true },
          orderBy: { id: "asc" },
          with: { author: { columns: { name: true } } },
        },
      },
    },
  },
  orderBy: { id: "asc" },
});

$.display("Authors with posts and comments", authors);

// Filters are objects too, and can follow a relation: posts with at least one comment by Ada.
const commentedByAda = await db.query.posts.findMany({
  columns: { title: true },
  where: { comments: { author: { name: "Ada" } } },
  with: { author: { columns: { name: true } } },
});

$.display("Posts Ada commented on", commentedByAda);
