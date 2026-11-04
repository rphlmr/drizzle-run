import { db } from "@drizzle-run/runtime/context";
import { asc, eq, sql } from "drizzle-orm";

import { accounts } from "./schema";

// Both updates commit together, or not at all.
await db.transaction(async (tx) => {
  await tx.update(accounts).set({ balance: sql`${accounts.balance} - 30` }).where(eq(accounts.owner, "Ada"));
  await tx.update(accounts).set({ balance: sql`${accounts.balance} + 30` }).where(eq(accounts.owner, "Grace"));

  // A nested transaction is a savepoint: it fails and rolls back alone.
  try {
    await tx.transaction(async (savepoint) => {
      await savepoint.update(accounts).set({ balance: 0 }).where(eq(accounts.owner, "Grace"));
      throw new Error("Changed our mind");
    });
  } catch (error) {
    console.log("Savepoint rolled back:", error instanceof Error ? error.message : error);
  }
});

// tx.rollback() throws, so nothing in this transaction is kept.
try {
  await db.transaction(async (tx) => {
    await tx.delete(accounts);
    tx.rollback();
  });
} catch {
  console.log("Whole transaction rolled back");
}

$.display("Balances", await db.select().from(accounts).orderBy(asc(accounts.id)));
