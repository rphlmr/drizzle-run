import { db } from "@drizzle-run/runtime/context";

import { posts, users } from "./schema";

await db.insert(users).values([
  { id: 1, name: "Ada", bio: "Writes about SQL", active: true },
  { id: 2, name: "Grace", bio: null, active: false },
]);

await db.insert(posts).values([
  { id: 1, authorId: 1, title: "Small SQL helpers" },
  { id: 2, authorId: 2, title: "Types that follow your query" },
  { id: 3, authorId: 1, title: "Compose your queries" },
]);
