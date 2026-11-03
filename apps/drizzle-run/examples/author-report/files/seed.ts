import { db } from "@drizzle-run/runtime/context";
import { authors, posts } from "./schema";

await db.insert(authors).values([
  { id: 1, name: "Ada" },
  { id: 2, name: "Grace" },
  { id: 3, name: "Linus" },
]);
await db.insert(posts).values([
  { id: 1, authorId: 1, title: "First query", published: true, views: 10 },
  { id: 2, authorId: 1, title: "Joining tables", published: true, views: 30 },
  { id: 3, authorId: 2, title: "Type safety", published: true, views: 5 },
  { id: 4, authorId: 2, title: "Draft notes", published: false, views: 100 },
]);
