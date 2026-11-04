import { db } from "@drizzle-run/runtime/context";
import { count, eq, max } from "drizzle-orm";

import { coalesceNumber } from "./helpers";
import { authors, scores } from "./schema";

const report = await db.select({
  author: authors.name,
  bestScore: coalesceNumber(max(scores.points), 0),
  entries: count(scores.id),
}).from(authors)
  .leftJoin(scores, eq(scores.authorId, authors.id))
  .groupBy(authors.id, authors.name)
  .orderBy(authors.id);

$.display("Scores with a typed fallback", report);
