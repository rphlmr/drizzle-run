import { db } from "@drizzle-run/runtime/context";
import { users } from "./schema";

await db.insert(users).values([
  { id: 1, name: "Ada" },
  { id: 2, name: "Grace" },
]);
