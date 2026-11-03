import { db } from "@drizzle-run/runtime/context";
import { sql } from "drizzle-orm";
import { products } from "./schema";

// -> keeps a JSON value; ->> returns text. Missing paths return SQL NULL.
const attributes = await db.select({
  name: products.name,
  color: sql<string | null>`${products.attributes}->>'color'`,
  shipping: sql<{ weightGrams: number } | null>`${products.attributes}->'shipping'`,
  weightGrams: sql<number | null>`(${products.attributes} #>> '{shipping,weightGrams}')::integer`,
}).from(products).orderBy(products.id);

$.display("Selected attributes", attributes);

// Values interpolated into sql are parameters, including this serialized JSON.
const wanted = { color: "blue", sizes: ["M"] };
const matching = await db.select().from(products)
  .where(sql`${products.attributes} @> ${JSON.stringify(wanted)}::jsonb`)
  .orderBy(products.id);

$.display("Blue products available in M", matching);

// These casts rely on weightGrams being numeric. Validate incoming JSON in your application.
const light = await db.select({ name: products.name }).from(products)
  .where(sql`(${products.attributes} #>> '{shipping,weightGrams}')::integer < ${300}`)
  .orderBy(products.id);

$.display("Products under 300 grams", light);

// ->> returns SQL NULL for both a missing key and JSON null. ? distinguishes presence.
const presence = await db.select({
  name: products.name,
  hasColor: sql<boolean>`${products.attributes} ? 'color'`,
  colorIsJsonNull: sql<boolean>`coalesce(${products.attributes}->'color' = 'null'::jsonb, false)`,
  colorText: sql<string | null>`${products.attributes}->>'color'`,
}).from(products).orderBy(products.id);

$.display("Missing color versus JSON null", presence);
