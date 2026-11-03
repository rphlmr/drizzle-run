import { db } from "@drizzle-run/runtime/context";
import { accounts } from "./schema";

await db.insert(accounts).values([
  { owner: "Ada", balance: 100 },
  { owner: "Grace", balance: 50 },
]);
