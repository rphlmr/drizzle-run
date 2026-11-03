import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { drizzle } from "drizzle-orm/d1";
import { migrate } from "drizzle-orm/d1/migrator";

import { openLocalD1, openProductionD1 } from "./local-d1.ts";

// Applies the drizzle/ migrations to the PLAYGROUNDS D1: the local one by default, the production one with --remote.
// Not `drizzle-kit migrate`: its d1-http driver reads the migrations table's rows as objects where the migrator
// expects arrays, so it fails on every database it already migrated once.
//
//   node scripts/migrate-d1.ts [--e2e]
//   node scripts/migrate-d1.ts --remote --account-id <account-id> [--config <wrangler config>]

const appDir = fileURLToPath(new URL("..", import.meta.url));
const migrationsFolder = resolve(appDir, "drizzle");

const { values } = parseArgs({
  options: {
    e2e: { type: "boolean", default: false },
    remote: { type: "boolean", default: false },
    "account-id": { type: "string" },
    config: { type: "string" },
  },
});

if (values.remote && (values.e2e || values["account-id"] === undefined)) {
  throw new Error("Pass --remote with --account-id <account-id>, and without --e2e.");
}

if (!values.remote && values.config !== undefined) {
  throw new Error("--config names a deployed database: pass it with --remote.");
}

if (values.remote && values["account-id"] !== undefined) {
  await migrateProductionD1(values["account-id"], values.config);
} else {
  await migrateLocalD1(values.e2e);
}

/** Applies the pending migrations to the deployed D1 a Wrangler config binds to PLAYGROUNDS (wrangler.jsonc by default). */
async function migrateProductionD1(accountId: string, configPath: string | undefined) {
  const productionD1 = await openProductionD1({
    accountId,
    ...(configPath === undefined ? {} : { configPath: resolve(configPath) }),
  });

  try {
    await migrate(drizzle(productionD1.database), { migrationsFolder });
    console.log("The deployed D1 is on the latest Drizzle migration.");
  } finally {
    await productionD1.dispose();
  }
}

/** Applies the pending migrations to the local D1. */
async function migrateLocalD1(e2e: boolean) {
  const localD1 = await openLocalD1({ e2e });

  try {
    await migrate(drizzle(localD1.database), { migrationsFolder });
    console.log("Local D1 is on the latest Drizzle migration.");
  } finally {
    await localD1.dispose();
  }
}
