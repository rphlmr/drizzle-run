import { db } from "@drizzle-run/runtime/context";

import { authors, scores } from "./schema";

await db.insert(authors).values([{ id: 1, name: "Ada" }, { id: 2, name: "Grace" }, { id: 3, name: "Linus" }]);
await db.insert(scores).values([{ id: 1, authorId: 1, points: 10 }, { id: 2, authorId: 1, points: null }, { id: 3, authorId: 3, points: 0 }]);
