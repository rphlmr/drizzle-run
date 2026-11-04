import { db } from "@drizzle-run/runtime/context";
import { eq } from "drizzle-orm";

import { products } from "./schema";

/** Fail if an invalid write succeeds or fails for a different reason. */
async function expectCheck(name: string, write: () => PromiseLike<unknown>) {
  try {
    await write();
  } catch (cause) {
    let error = cause;

    while (error instanceof Error) {
      if (error.message.includes(name)) {
        $.display(name, { rejected: true });
        return;
      }

      error = error.cause;
    }

    throw cause;
  }

  throw new Error(`Expected check "${name}" to reject the write`);
}

await expectCheck("stock_non_negative", () => db.insert(products).values({
  id: 2, name: "Invalid stock", priceCents: 1000, discountCents: 0, stock: -1,
}));
await expectCheck("discount_in_range", () => db.update(products)
  .set({ discountCents: 3000 }).where(eq(products.id, 1)));

// CHECK permits SQL null; required fields also need notNull().
await db.insert(products).values({ id: 3, name: "Pocket notes", priceCents: 500, discountCents: 0, restockThreshold: null });

$.display("Stored products", await db.select().from(products).orderBy(products.id));
