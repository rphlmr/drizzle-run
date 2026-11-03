import type { MigrationMeta } from "drizzle-orm/migrator";

import { toHex } from "../lib/hex";

const migrationFiles = import.meta.glob<string>("./migrations/*/migration.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

const statementBreakpoint = "--> statement-breakpoint";

/** The date at the start of a Kit migration folder name, such as `20261017084149`, in UTC milliseconds. */
function toFolderMillis(folderName: string): number {
  const stamp = folderName.slice(0, 14);

  if (!/^\d{14}$/.test(stamp)) {
    throw new Error(`Expected migration folder to start with a 14 digit timestamp, but got '${folderName}'.`);
  }

  return Date.UTC(
    Number(stamp.slice(0, 4)),
    Number(stamp.slice(4, 6)) - 1,
    Number(stamp.slice(6, 8)),
    Number(stamp.slice(8, 10)),
    Number(stamp.slice(10, 12)),
    Number(stamp.slice(12, 14)),
  );
}

async function toSha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

  return toHex(digest);
}

/**
 * Read the local store's bundled migrations
 *
 * Returns what drizzle-orm's `readMigrationFiles` returns for `src/store/migrations` on disk (same order, names,
 * statements and hashes), so `migrateAsync` applies them in the browser as it would anywhere else.
 */
export async function readStoreMigrations(): Promise<MigrationMeta[]> {
  const folders = Object.entries(migrationFiles)
    .map(([path, query]) => ({ name: path.split("/").at(-2) ?? path, query }))
    .toSorted((left, right) => left.name.localeCompare(right.name));

  return Promise.all(
    folders.map(async ({ name, query }) => ({
      sql: query.split(statementBreakpoint),
      bps: true,
      folderMillis: toFolderMillis(name),
      hash: await toSha256Hex(query),
      name,
    })),
  );
}
