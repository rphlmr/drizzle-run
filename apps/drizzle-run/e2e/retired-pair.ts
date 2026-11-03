import { createHash } from "node:crypto";

import type { Page } from "@playwright/test";

/** The pins of a Next pair the catalog no longer ships. */
export const removedNext = { "drizzle-orm": "1.0.0-rc.3", "drizzle-kit": "1.0.0-rc.3" };
/** The pins of an older Legacy fix release. */
export const olderLegacy = { "drizzle-orm": "0.44.0", "drizzle-kit": "0.30.0" };

function makePinnedManifest(dependencies: Record<string, string>) {
  return {
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "sqlite" },
    dependencies,
    entrypoints: { schema: "schema.ts", run: "query.ts" },
    files: {
      "schema.ts":
        'import { sqliteTable, integer } from "drizzle-orm/sqlite-core";\n\nexport const records = sqliteTable("records", { id: integer("id").primaryKey() });\n',
      "query.ts": '$.display("Kept", [{ kept: true }]);\n',
    },
  };
}

/** A stored v2 project record pinned to the given versions. */
export function makeStoredRecord(id: string, name: string, dependencies: Record<string, string>) {
  const now = new Date().toISOString();

  return {
    version: 1,
    id,
    name,
    createdAt: now,
    updatedAt: now,
    revision: 3,
    trust: "trusted" as const,
    manifest: makePinnedManifest(dependencies),
  };
}

/** The pins of the Next pair the catalog ships. */
const currentNext = { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" };

/** A stored v2 side-by-side record with shared files: the first side on the current Next pair, the second on `dependencies`. */
export function makeStoredPairRecord(id: string, name: string, dependencies: Record<string, string>) {
  const { entrypoints, files } = makePinnedManifest(currentNext);

  return {
    ...makeStoredRecord(id, name, currentNext),
    manifest: {
      kind: "drizzle-run-pair",
      manifestVersion: 1,
      entrypoints,
      files,
      sides: [
        { target: { dialect: "sqlite" }, dependencies: currentNext, files: {} },
        { target: { dialect: "sqlite" }, dependencies, files: {} },
      ],
    },
  };
}

// Must match the client's canonical JSON for snapshot digests: sorted keys, no whitespace.
function toCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(toCanonicalJson).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${toCanonicalJson(entry)}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

/**
 * Serves a published snapshot pinned to the given versions, as the API serves
 * one whose pair left the catalog. Publishing such a pair is refused, so it
 * cannot be created through the API.
 */
export async function serveSnapshot(page: Page, id: string, dependencies: Record<string, string>): Promise<void> {
  const snapshot = { snapshotVersion: 1, name: "Shared on an old pair", manifest: makePinnedManifest(dependencies) };
  const digest = createHash("sha256").update(toCanonicalJson(snapshot)).digest("hex");

  await page.route(`**/api/playgrounds/${id}`, (route) =>
    route.fulfill({
      json: {
        snapshot,
        digest,
        updatedAt: "2026-01-01T00:00:00.000Z",
        description: null,
      },
    }),
  );
}
