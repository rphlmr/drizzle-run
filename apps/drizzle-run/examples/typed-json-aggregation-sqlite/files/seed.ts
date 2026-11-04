import { db } from "@drizzle-run/runtime/context";

import { authors, comments } from "./schema";

await db.insert(authors).values([{ id: 1, name: "Ada" }, { id: 2, name: "Grace" }, { id: 3, name: "Linus" }]);
await db.insert(comments).values([{ id: 2, authorId: 1, text: null }, { id: 1, authorId: 1, text: "Ready to review" }, { id: 3, authorId: 3, text: "Keep this version" }]);
