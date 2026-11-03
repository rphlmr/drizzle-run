import { db } from "@drizzle-run/runtime/context";
import { users } from "./schema";

await db.insert(users).values([
  { name: "Ada", email: "ada@example.com", credits: 10 },
  { name: "Grace", email: "grace@example.com", credits: 5 },
]);
