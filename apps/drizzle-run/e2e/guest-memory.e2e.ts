import type { RunManifest } from "@drizzle-run/core/manifest";

import { expect, test } from "./fixtures";
import { groupDisplaysByLabel, runStoredProject } from "./run-project";

/**
 * A shared project is code anyone can publish. Its guest's memory is capped at 192 MiB by QuickJS
 * (packages/runtime/src/quickjs/vm.ts): this run allocates past it, and the run must fail while the tab
 * keeps running projects.
 */

const ALLOCATE_QUERY = `
const chunks = [];

for (let index = 0; index < 2048; index += 1) {
  chunks.push(new Uint8Array(1024 * 1024).fill(index % 256));
}

$.display("Allocated MiB", chunks.length);
`;

function createSqliteManifest(query: string): RunManifest {
  return {
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "sqlite" },
    dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
    entrypoints: { schema: "schema.ts", run: "query.ts" },
    files: {
      "schema.ts":
        'import { sqliteTable, integer } from "drizzle-orm/sqlite-core";\n\nexport const items = sqliteTable("items", { id: integer("id").primaryKey() });\n',
      "query.ts": query,
    },
  };
}

test("should fail a run that allocates past the guest memory cap, and keep running projects after it", async ({
  page,
}) => {
  await page.goto("/projects");

  const allocated = await runStoredProject(page, "Guest memory cap", createSqliteManifest(ALLOCATE_QUERY));
  const next = await runStoredProject(page, "After the memory cap", createSqliteManifest('$.display("Next", 1);\n'));

  expect(allocated.outcome, JSON.stringify(allocated.error ?? null)).toBe("failed");
  expect(groupDisplaysByLabel(allocated)["Allocated MiB"]).toBeUndefined();
  expect(next.outcome, JSON.stringify(next.error ?? null)).toBe("succeeded");
});
