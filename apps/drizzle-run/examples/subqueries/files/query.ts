import { db } from "@drizzle-run/runtime/context";
import { eq, inArray } from "drizzle-orm";
import { authors, posts } from "./schema";

// Leave the inner query unawaited so Drizzle embeds it in the outer SQL.
const publishedAuthorIds = db.select({ authorId: posts.authorId }).from(posts).where(eq(posts.published, true));

const publishedAuthors = await db
  .select({ name: authors.name })
  .from(authors)
  .where(inArray(authors.id, publishedAuthorIds))
  .orderBy(authors.id);

$.display("Authors with published posts", publishedAuthors);
