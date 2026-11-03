import { db } from "@drizzle-run/runtime/context";
import { posts, users } from "./schema";

await db.insert(users).values([
  { id: 1, name: "Ada" },
  { id: 2, name: "Grace" },
  { id: 3, name: "Linus" },
]);

await db.insert(posts).values([
  { title: "Hello", authorId: 1 },
  { title: "Notes", authorId: 1 },
  { title: "Ships", authorId: 2 },
]);
