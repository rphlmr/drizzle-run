import { db } from "@drizzle-run/runtime/context";
import { eq, sql } from "drizzle-orm";
import { users } from "./schema";

$.display("Before", await db.select().from(users).orderBy(users.id));

// Update the stored JSON directly. Ada keeps her theme and SMS setting.
const emailEnabled = false;
const ada = await db.update(users).set({
  preferences: sql`jsonb_set(
    ${users.preferences}, '{notifications,email}', to_jsonb(${emailEnabled}::boolean), true
  )`,
}).where(eq(users.id, 1)).returning();

$.display("Ada keeps her other preferences", ada);

// create_if_missing creates the final key, not missing intermediate objects.
const unchanged = await db.update(users).set({
  preferences: sql`jsonb_set(
    ${users.preferences}, '{notifications,email}', to_jsonb(${emailEnabled}::boolean), true
  )`,
}).where(eq(users.id, 3)).returning();

$.display("Linus still has no notifications object", unchanged);

// Merge inside notifications, then set that object. Root-level || would replace all notifications.
// The schema's TypeScript shape assumes notifications is an object when present.
const linus = await db.update(users).set({
  preferences: sql`jsonb_set(
    ${users.preferences},
    '{notifications}',
    coalesce(${users.preferences}->'notifications', '{}'::jsonb)
      || jsonb_build_object('email', ${emailEnabled}::boolean),
    true
  )`,
}).where(eq(users.id, 3)).returning();

$.display("Linus gets the missing parent", linus);
$.display("After, including unchanged Grace", await db.select().from(users).orderBy(users.id));
