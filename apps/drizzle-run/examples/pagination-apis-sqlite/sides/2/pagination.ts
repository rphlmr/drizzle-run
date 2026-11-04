import { db } from "@drizzle-run/runtime/context";
import { EmptyFilter } from "drizzle-orm";

import type { posts } from "./schema";

type Cursor = Pick<typeof posts.$inferSelect, "createdAt" | "id">;

/** Fetch after an exclusive composite cursor. Callers validate a positive pageSize before calling. */
export async function getNextPage({ after, pageSize = 2 }: { after?: Cursor; pageSize?: number } = {}) {
  const rows = await db.query.posts.findMany({
    where: after === undefined ? EmptyFilter : {
      OR: [
        { createdAt: { gt: after.createdAt } },
        { createdAt: after.createdAt, id: { gt: after.id } },
      ],
    },
    orderBy: { createdAt: "asc", id: "asc" },
    limit: pageSize + 1,
  });
  const items = rows.slice(0, pageSize);
  const hasNextPage = rows.length > pageSize;
  const last = items.at(-1);

  return {
    items,
    hasNextPage,
    nextCursor: hasNextPage && last ? { createdAt: last.createdAt, id: last.id } : null,
  };
}
