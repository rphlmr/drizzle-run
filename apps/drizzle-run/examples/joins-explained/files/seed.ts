import { db } from "@drizzle-run/runtime/context";
import { authors, books } from "./schema";

await db.insert(authors).values([
  { id: 1, name: "Ada" },
  { id: 2, name: "Grace" },
  { id: 3, name: "Linus" },
]);
await db.insert(books).values([
  { id: 1, authorId: 1, title: "Types in practice", published: true },
  { id: 2, authorId: 1, title: "Draft notes", published: false },
  { id: 3, authorId: 2, title: "Compilers", published: false },
  { id: 4, authorId: null, title: "Anonymous tale", published: true },
]);
