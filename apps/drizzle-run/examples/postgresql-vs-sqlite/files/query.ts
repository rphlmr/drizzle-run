import { db } from "@drizzle-run/runtime/context";
import { asc, eq } from "drizzle-orm";
import { tasks } from "./schema";

// The same code on both sides: only the schema knows which database it runs on.
const [shipped] = await db.update(tasks).set({ done: true }).where(eq(tasks.title, "Ship it")).returning();

$.display("Updated task", shipped);

// done reads as true or false and dueAt as a Date on both sides. Open SQL to see what each database stores.
const open = await db.select().from(tasks).where(eq(tasks.done, false)).orderBy(asc(tasks.dueAt));

$.display("Open tasks", open);
