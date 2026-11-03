import { db } from "@drizzle-run/runtime/context";
import { users } from "./schema";

await db.insert(users).values([
  { id: 1, name: "Ada", preferences: { theme: "dark", notifications: { email: true, sms: true } } },
  { id: 2, name: "Grace", preferences: { theme: "light", notifications: {} } },
  { id: 3, name: "Linus", preferences: { theme: "dark" } },
]);
