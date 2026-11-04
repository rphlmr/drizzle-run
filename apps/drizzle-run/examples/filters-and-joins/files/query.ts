import { db } from "@drizzle-run/runtime/context";
import { and, count, desc, eq, gte, like, or } from "drizzle-orm";

import { authors, books } from "./schema";

const modern = await db
  .select({ title: books.title, year: books.year })
  .from(books)
  .where(and(gte(books.year, 1970), or(eq(books.genre, "Science fiction"), like(books.title, "%Cities%"))))
  .orderBy(desc(books.year));

$.display("Science fiction or cities, since 1970", modern);

// A left join keeps books without an author.
const withAuthors = await db
  .select({ title: books.title, author: authors.name })
  .from(books)
  .leftJoin(authors, eq(books.authorId, authors.id));

$.display("Books and authors", withAuthors);

// Count book ids, not joined rows: Toni has no seeded books, so her count is zero.
const perAuthor = await db
  .select({ author: authors.name, books: count(books.id) })
  .from(authors)
  .leftJoin(books, eq(books.authorId, authors.id))
  .groupBy(authors.id)
  .orderBy(desc(count(books.id)), authors.id);

$.display("Books per author", perAuthor);
