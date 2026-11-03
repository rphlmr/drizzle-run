import { defineConfig } from "drizzle-kit";

// drizzle-kit config for the browser's local store (src/store). The Worker's D1 has its own config and migrations,
// so the two schemas never mix. The app bundles src/store/migrations and applies them when the store opens.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/store/schema.ts",
  out: "./src/store/migrations",
});
