import { db } from "@drizzle-run/runtime/context";
import { createInsertSchema } from "drizzle-orm/zod";
import * as z from "zod";

import { users } from "./schema";

// Column types and nullability come from the table; refinements add input rules.
// Validation does not check whether an email is already stored. The unique constraint does that on insert.
const insertUser = createInsertSchema(users, {
  name: (schema) => schema.min(1),
  email: (schema) => schema.pipe(z.email()),
  age: (schema) => schema.min(0).max(150),
});

const candidates = [
  { name: "Ada", email: "ada@example.com", age: 36 },
  { name: "", email: "grace@example.com" },
  { name: "Alan", email: "not-an-email", age: 200 },
];

const checked = candidates.map((candidate) => {
  const parsed = insertUser.safeParse(candidate);

  return parsed.success
    ? { email: candidate.email, valid: true, problems: "", row: parsed.data }
    : {
      email: candidate.email,
      valid: false,
      problems: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      row: undefined,
    };
});

$.display("Validation", checked.map(({ email, valid, problems }) => ({ email, valid, problems })));

const validRows = checked.flatMap((item) => (item.row ? [item.row] : []));

await db.insert(users).values(validRows);

$.display("Inserted users", await db.select().from(users));
