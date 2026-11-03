import { db } from "@drizzle-run/runtime/context";
import { eq } from "drizzle-orm";
import { authors, books } from "./schema";

const rows = await db
  .select({ author: authors.name, title: books.title })
  .from(authors)
  .innerJoin(books, eq(books.authorId, authors.id))
  .orderBy(authors.id, books.id);

$.display("Matching authors and books", rows);
