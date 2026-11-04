import { db } from "@drizzle-run/runtime/context";
import { and, eq } from "drizzle-orm";

import { getJsonText, hasJsonArrayValue } from "./helpers";
import { products } from "./schema";

const color = getJsonText(products.attributes, "color");
const availableInM = hasJsonArrayValue(products.attributes, "sizes", "M");

$.display("Selected colors", await db.select({ name: products.name, color }).from(products).orderBy(products.id));
$.display("Blue products available in M", await db.select().from(products)
  .where(and(eq(color, "blue"), availableInM)).orderBy(products.id));

// $type is an application contract, not validation of JSON arriving from a request.
// The helpers restrict keys to their declared text or string-array fields.
