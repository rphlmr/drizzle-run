import { db } from "@drizzle-run/runtime/context";

import { comments, posts, users } from "./schema";

const [ada, grace] = await db.insert(users).values([{ name: "Ada" }, { name: "Grace" }]).returning();

const [hello, relations, types] = await db.insert(posts).values([
  { authorId: ada.id, title: "Hello, Drizzle" },
  { authorId: ada.id, title: "Relations in one query" },
  { authorId: grace.id, title: "Types all the way down" },
]).returning();

await db.insert(comments).values([
  { postId: hello.id, authorId: grace.id, body: "Welcome aboard." },
  { postId: relations.id, authorId: grace.id, body: "One round trip, nice." },
  { postId: types.id, authorId: ada.id, body: "Inferred from the schema, nice." },
  { postId: types.id, authorId: grace.id, body: "No codegen step either." },
]);
