import { db } from "@drizzle-run/runtime/context";
import { eq } from "drizzle-orm";

import { jsonbBuildObject, jsonbAggregate } from "./helpers";
import { authors, comments } from "./schema";

// Filtering the child ID removes the missing join row, while keeping real nullable properties.
const report = await db.select({
  author: authors.name,
  comments: jsonbAggregate({
    value: jsonbBuildObject({ id: comments.id, text: comments.text }),
    orderBy: comments.id,
    present: comments.id,
  }),
}).from(authors)
  .leftJoin(comments, eq(comments.authorId, authors.id))
  .groupBy(authors.id, authors.name)
  .orderBy(authors.id);

$.display("Authors with ordered comments", report);
