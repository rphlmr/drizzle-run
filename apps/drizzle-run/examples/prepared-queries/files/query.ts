import { db } from "@drizzle-run/runtime/context";
import { eq } from "drizzle-orm";
import { products } from "./schema";

const category = "books";
const books = await db
  .select()
  .from(products)
  .where(eq(products.category, category))
  .orderBy(products.priceCents, products.id);

$.display("Books", books);
