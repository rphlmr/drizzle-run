import { db } from "@drizzle-run/runtime/context";
import { posts } from "./schema";

// SQLite text timestamps use the same fixed-width UTC ISO format so text ordering follows time.
await db.insert(posts).values([
  { id: 1, title: "First", createdAt: "2026-01-01T09:00:00.000Z" },
  { id: 2, title: "Second", createdAt: "2026-01-01T09:00:00.000Z" },
  { id: 3, title: "Same timestamp", createdAt: "2026-01-01T09:00:00.000Z" },
  { id: 4, title: "Fourth", createdAt: "2026-01-02T09:00:00.000Z" },
  { id: 5, title: "Fifth", createdAt: "2026-01-02T09:00:00.000Z" },
  { id: 6, title: "Last", createdAt: "2026-01-03T09:00:00.000Z" },
]);
