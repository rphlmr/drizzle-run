import { integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";

// Validate external input before writing it; $type only describes the TypeScript shape.
type Preferences = {
  theme?: "light" | "dark";
  notifications?: { email?: boolean; sms?: boolean };
};

export const users = pgTable("users", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  preferences: jsonb("preferences").$type<Preferences>().notNull().default({}),
});
