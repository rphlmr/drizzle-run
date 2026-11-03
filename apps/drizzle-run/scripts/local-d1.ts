import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { D1Database } from "@cloudflare/workers-types";

const appDir = fileURLToPath(new URL("..", import.meta.url));

/**
 * Wrangler's local D1, R2 and Durable Object storage, shared by every local command
 *
 * `--persist-to <dir>` stores under <dir>/v3, which getPlatformProxy takes directly. DRIZZLE_RUN_STATE_DIR (relative
 * to the repository) is the same override serve-drizzle-run.ts honours, so a second server's scripts reach the D1 it
 * serves.
 */
export const localState = resolve(appDir, "../..", process.env.DRIZZLE_RUN_STATE_DIR ?? ".cache/cloudflare", "v3");

/**
 * Open the local PLAYGROUNDS D1 that `pnpm dev`, `pnpm preview` and the e2e server share
 *
 * Only the D1 binding is used. The platform proxy never loads worker/index.ts, so handing it the full config makes
 * workerd warn that the Durable Object classes are not exported: it gets a config holding only the D1 binding instead.
 * Call `dispose` when done, so workerd exits.
 *
 * @param options.e2e - Reads wrangler.jsonc's `e2e` environment instead of the default one.
 */
export async function openLocalD1({ e2e = false } = {}) {
  return openPlaygroundsD1({
    configPath: resolve(appDir, "wrangler.jsonc"),
    environmentName: e2e ? "e2e" : undefined,
    target: { kind: "local" },
  });
}

/**
 * Open the deployed PLAYGROUNDS D1 that a Wrangler config binds, through a Wrangler remote binding
 *
 * Credentials come from `wrangler login` or `CLOUDFLARE_API_TOKEN`, as for `wrangler deploy`. Call `dispose` when done.
 *
 * @param options.accountId - The Cloudflare account that owns the database
 * @param options.configPath - The Wrangler config naming the database: wrangler.jsonc for production, or a pull
 *   request preview's generated config
 */
export async function openProductionD1({
  accountId,
  configPath = resolve(appDir, "wrangler.jsonc"),
}: {
  accountId: string;
  configPath?: string;
}) {
  return openPlaygroundsD1({ configPath, environmentName: undefined, target: { kind: "remote", accountId } });
}

/**
 * Open the PLAYGROUNDS binding of a wrangler.jsonc environment, on local storage or on the account
 */
async function openPlaygroundsD1({
  configPath,
  environmentName,
  target,
}: {
  configPath: string;
  environmentName?: string;
  target: { kind: "local" } | { kind: "remote"; accountId: string };
}) {
  process.env.WRANGLER_LOG ??= "error";
  const { getPlatformProxy, unstable_readConfig } = await import("wrangler");

  const appConfig: {
    name: string;
    compatibility_date: string;
    d1_databases: { binding: string; database_name: string; database_id: string }[];
  } = unstable_readConfig({ config: configPath, env: environmentName });
  const remote = target.kind === "remote";
  const d1ConfigDir = await mkdtemp(join(tmpdir(), "drizzle-run-d1-"));
  const d1ConfigPath = join(d1ConfigDir, "wrangler.json");

  await writeFile(
    d1ConfigPath,
    JSON.stringify({
      name: appConfig.name,
      compatibility_date: appConfig.compatibility_date,
      ...(target.kind === "remote" ? { account_id: target.accountId } : {}),
      d1_databases: appConfig.d1_databases.map((database) => ({ ...database, remote })),
    }),
  );

  let proxy;

  try {
    proxy = await getPlatformProxy<{ PLAYGROUNDS: D1Database }>({
      configPath: d1ConfigPath,
      envFiles: [],
      persist: remote ? false : { path: localState },
    });
  } catch (cause) {
    await rm(d1ConfigDir, { recursive: true, force: true });
    const databaseNames = appConfig.d1_databases.map((database) => database.database_name).join(", ");

    throw new Error(
      remote ? `Cannot open the deployed D1 ${databaseNames}` : `Cannot open the local D1 in ${localState}`,
      { cause },
    );
  }

  const { env, dispose } = proxy;

  return {
    database: env.PLAYGROUNDS,
    async dispose() {
      await dispose();
      await rm(d1ConfigDir, { recursive: true, force: true });
    },
  };
}
