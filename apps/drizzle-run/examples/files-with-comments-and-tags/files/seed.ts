import { db } from "@drizzle-run/runtime/context";
import { comments, files, fileTags, tags, users } from "./schema";

await db.insert(users).values([{ id: 1, name: "Ada" }, { id: 2, name: "Grace" }]);
await db.insert(files).values([
  { id: 1, name: "Launch notes" },
  { id: 2, name: "Empty draft" },
  { id: 3, name: "Design sketch" },
]);
await db.insert(comments).values([
  { id: 1, fileId: 1, authorId: 1, text: "Ready to review" },
  { id: 2, fileId: 1, authorId: 2, text: null },
  { id: 3, fileId: 3, authorId: 1, text: "Keep this version" },
]);
await db.insert(tags).values([
  { id: 1, name: "release" },
  { id: 2, name: "review" },
  { id: 3, name: "team" },
]);
await db.insert(fileTags).values([
  { fileId: 1, tagId: 1 },
  { fileId: 1, tagId: 2 },
  { fileId: 1, tagId: 3 },
  { fileId: 3, tagId: 2 },
]);
