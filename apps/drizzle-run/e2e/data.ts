import type { Page } from "@playwright/test";

import type { StoredProject } from "../src/store/service";
import { callStore } from "./store";

/** A stored project record for the home page tests; `index` sets its age, name and database. */
export function projectRecord(index: number) {
  const now = Date.UTC(2026, 9, 13, 12) - index * 3_600_000;
  const dialect = index % 3 === 0 ? "sqlite" : "postgresql";
  const core = dialect === "sqlite" ? "sqlite-core" : "pg-core";
  const table = dialect === "sqlite" ? "sqliteTable" : "pgTable";

  return {
    version: 1,
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name: `Stored ${index + 1}`,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    revision: 1,
    trust: "trusted" as const,
    manifest: {
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect },
      dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
      entrypoints: { schema: "schema.ts", run: "query.ts" },
      files: {
        "schema.ts": `import { ${table}, integer } from "drizzle-orm/${core}";\n\nexport const items = ${table}("items", { id: integer("id").primaryKey() });\n`,
        "query.ts": "export {};\n",
      },
    },
  };
}

/** Writes project records into the app's local store, then opens `path`, so the app reads them on load. */
export async function storeProjects(page: Page, records: readonly StoredProject[], path = "/"): Promise<void> {
  await callStore(page, "saveProjects", records, []);
  await page.goto(path);
}
