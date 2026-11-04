import { db } from "@drizzle-run/runtime/context";
import { count, eq, gte, sql, sum } from "drizzle-orm";

import { authors, posts } from "./schema";

const publishedStats = db.$with("published_stats").as(
  db
    .select({
      authorId: posts.authorId,
      publishedCount: count(posts.id).as("published_count"),
      totalViews: sum(posts.views).as("total_views"),
    })
    .from(posts)
    .where(eq(posts.published, true))
    .groupBy(posts.authorId),
);

const selection = {
  name: authors.name,
  // PostgreSQL aggregate values can be strings. Convert at the outer selection.
  // These sample totals fit safely in a JavaScript number.
  publishedPosts: sql<number>`coalesce(${publishedStats.publishedCount}, 0)`.mapWith(Number),
  views: sql<number>`coalesce(${publishedStats.totalViews}, 0)`.mapWith(Number),
};

const report = await db
  .with(publishedStats)
  .select(selection)
  .from(authors)
  .leftJoin(publishedStats, eq(publishedStats.authorId, authors.id))
  .orderBy(authors.id);

$.display("Author report", report);

const minimumViews = 30;
const popular = await db
  .with(publishedStats)
  .select(selection)
  .from(authors)
  .leftJoin(publishedStats, eq(publishedStats.authorId, authors.id))
  .where(gte(publishedStats.totalViews, String(minimumViews)))
  .orderBy(authors.id);

$.display("Authors with at least 30 published views", popular);
