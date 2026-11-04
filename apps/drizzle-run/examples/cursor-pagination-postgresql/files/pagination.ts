import { db } from "@drizzle-run/runtime/context";
import { and, asc, eq, gt, or } from "drizzle-orm";

import { posts } from "./schema";

type Cursor = Pick<typeof posts.$inferSelect, "createdAt" | "id">;

/** Fetch after an exclusive composite cursor. Callers validate a positive pageSize before calling. */
export async function getNextPage({ after, pageSize = 2 }: { after?: Cursor; pageSize?: number } = {}) {
  const rows = await db.select().from(posts)
    .where(after === undefined ? undefined : or(
      gt(posts.createdAt, after.createdAt),
      and(eq(posts.createdAt, after.createdAt), gt(posts.id, after.id)),
    ))
    .orderBy(asc(posts.createdAt), asc(posts.id))
    .limit(pageSize + 1);
  const items = rows.slice(0, pageSize);
  const hasNextPage = rows.length > pageSize;
  const last = items.at(-1);

  return {
    items,
    hasNextPage,
    nextCursor: hasNextPage && last ? { createdAt: last.createdAt, id: last.id } : null,
  };
}
