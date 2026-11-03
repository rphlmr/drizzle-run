import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "drizzle-kit";

// drizzle-kit reads the Worker's schema and writes migrations to drizzle/. With the CLOUDFLARE_* variables below set,
// `drizzle-kit studio` reaches the production D1 over Cloudflare's HTTP API. Without them, Studio opens the local D1
// that `pnpm dev` and `wrangler dev` share. Migrations go through scripts/migrate-d1.ts instead of `drizzle-kit
// migrate`, whose d1-http driver fails on a database it already migrated. See docs/cloudflare.md.
const localD1Directory = fileURLToPath(
  new URL("../../.cache/cloudflare/v3/d1/miniflare-D1DatabaseObject/", import.meta.url),
);

/** The local D1 file, the most recently written one when an older database is still there; null before `pnpm dev`. */
function findLocalD1File(): string | null {
  let names: string[];

  try {
    // Miniflare keeps its own metadata.sqlite beside the databases.
    names = readdirSync(localD1Directory).filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");
  } catch {
    return null;
  }

  const [latest] = names
    .map((name) => `${localD1Directory}${name}`)
    .toSorted((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);

  return latest ?? null;
}

const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_D1_TOKEN } = process.env;
const shared = { dialect: "sqlite", schema: "./worker/schema.ts", out: "./drizzle" } as const;

function createConfig() {
  if (CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_D1_DATABASE_ID && CLOUDFLARE_D1_TOKEN) {
    return defineConfig({
      ...shared,
      driver: "d1-http",
      dbCredentials: {
        accountId: CLOUDFLARE_ACCOUNT_ID,
        databaseId: CLOUDFLARE_D1_DATABASE_ID,
        token: CLOUDFLARE_D1_TOKEN,
      },
    });
  }

  const localD1File = findLocalD1File();

  return defineConfig(localD1File === null ? shared : { ...shared, dbCredentials: { url: `file:${localD1File}` } });
}

export default createConfig();
