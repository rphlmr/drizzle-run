import { db } from "@drizzle-run/runtime/context";
import { posts, users } from "./schema";

await db.insert(users).values({ id: 1, name: "Ada" });
await db.insert(posts).values({ id: 1, authorId: 1, title: "The first draft" });
