import { db } from "@drizzle-run/runtime/context";
import { tasks } from "./schema";

await db.insert(tasks).values([
  { title: "Write the schema", done: true, dueAt: new Date("2026-10-01T09:00:00Z") },
  { title: "Seed the database", dueAt: new Date("2026-10-02T09:00:00Z") },
  { title: "Ship it", dueAt: new Date("2026-10-03T09:00:00Z") },
]);
