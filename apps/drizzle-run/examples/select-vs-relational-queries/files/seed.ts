import { db } from "@drizzle-run/runtime/context";

import { posts, users } from "./schema";

const [ada, grace] = await db
  .insert(users)
  .values([{ name: "Ada" }, { name: "Grace" }, { name: "Linus" }])
  .returning();

await db.insert(posts).values([
  { authorId: ada.id, title: "Hello, Drizzle" },
  { authorId: ada.id, title: "Joins without the boilerplate" },
  { authorId: grace.id, title: "Types all the way down" },
]);
