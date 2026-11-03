import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { resolveDeployEnvironment, toDeployWranglerConfig } from "./deploy-environment.ts";

// Creates or deletes a deploy environment's Cloudflare resources with CLOUDFLARE_API_TOKEN. `delete` needs only Node,
// so a closed pull request can skip the install.
//
//   node scripts/manage-deploy-environment.ts prepare --name <next|pr-N> --account-id <account-id>
//   node scripts/manage-deploy-environment.ts delete --name <pr-N> --account-id <account-id>

const appDir = fileURLToPath(new URL("..", import.meta.url));
const deployConfigPath = resolve(appDir, "wrangler.deploy.json");

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    "account-id": { type: "string" },
  },
});

const [command] = positionals;
const environment = resolveDeployEnvironment(values.name ?? "");
const accountId = values["account-id"];
const apiToken = process.env.CLOUDFLARE_API_TOKEN;

if ((command !== "prepare" && command !== "delete") || environment === null || accountId === undefined) {
  throw new Error("Usage: manage-deploy-environment.ts <prepare|delete> --name <next|pr-N> --account-id <account-id>");
}

if (!/^[a-f0-9]{32}$/.test(accountId)) {
  throw new Error(`Expected a 32-character Cloudflare account ID, but got ${accountId}`);
}

if (!apiToken) {
  throw new Error("Set CLOUDFLARE_API_TOKEN to a token with Workers Scripts, D1 and R2 edit permissions.");
}

/**
 * Calls the account's Cloudflare API, and throws unless it succeeds or answers one of `expectedStatuses`
 *
 * @param options.expectedStatuses - Failure statuses the caller handles, such as 404 for a missing resource
 * @returns The response status, and the result of a successful call
 */
interface CloudflareRequest {
  method: string;
  path: string;
  body?: unknown;
  expectedStatuses?: number[];
}

async function callCloudflare<TResult>(
  options: CloudflareRequest & { expectedStatuses?: undefined },
): Promise<{ status: number; result: TResult }>;
async function callCloudflare<TResult>(
  options: CloudflareRequest,
): Promise<{ status: number; result: TResult | undefined }>;
async function callCloudflare<TResult>({ method, path, body, expectedStatuses = [] }: CloudflareRequest) {
  const authorization = { Authorization: `Bearer ${apiToken}` };
  const request =
    body === undefined
      ? { method, headers: authorization }
      : { method, headers: { ...authorization, "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, request);

  if (expectedStatuses.includes(response.status)) {
    await response.body?.cancel();

    return { status: response.status, result: undefined };
  }

  const payload: { success: boolean; errors: unknown; result: TResult } = await response.json();

  if (!response.ok || !payload.success) {
    throw new Error(
      `Cloudflare API ${method} ${path} failed with ${response.status}: ${JSON.stringify(payload.errors)}`,
    );
  }

  return { status: response.status, result: payload.result };
}

async function findDatabaseId(databaseName: string) {
  const { result: databases } = await callCloudflare<{ name: string; uuid: string }[]>({
    method: "GET",
    path: `/d1/database?name=${encodeURIComponent(databaseName)}`,
  });

  return databases.find((database) => database.name === databaseName)?.uuid ?? null;
}

async function ensureDatabase(databaseName: string) {
  const existingId = await findDatabaseId(databaseName);

  if (existingId !== null) {
    return existingId;
  }

  const { result: created } = await callCloudflare<{ uuid: string }>({
    method: "POST",
    path: "/d1/database",
    body: { name: databaseName },
  });
  console.log(`Created D1 ${databaseName} (${created.uuid}).`);

  return created.uuid;
}

async function ensureBucket(bucketName: string) {
  const { status } = await callCloudflare({
    method: "GET",
    path: `/r2/buckets/${bucketName}`,
    expectedStatuses: [404],
  });

  if (status !== 404) {
    return;
  }

  // 409: another pull request's deploy created it meanwhile.
  const created = await callCloudflare({
    method: "POST",
    path: "/r2/buckets",
    body: { name: bucketName },
    expectedStatuses: [409],
  });

  if (created.status !== 409) {
    console.log(`Created R2 bucket ${bucketName}.`);
  }
}

if (command === "prepare") {
  const [databaseId] = await Promise.all([
    ensureDatabase(environment.databaseName),
    ensureBucket(environment.runtimeAssetsBucket),
    ensureBucket(environment.cloudProjectsBucket),
  ]);

  // Imported here only, so `delete` runs without an install.
  const { experimental_readRawConfig } = await import("wrangler");
  const { rawConfig } = experimental_readRawConfig({ config: resolve(appDir, "wrangler.jsonc") });

  await writeFile(
    deployConfigPath,
    `${JSON.stringify(toDeployWranglerConfig(rawConfig, environment, databaseId), null, 2)}\n`,
  );
  console.log(`Wrote ${deployConfigPath} for ${environment.workerName}.`);
} else {
  if (environment.kind !== "pull_request") {
    throw new Error(`Expected a pull request preview (pr-N) to delete, but got ${environment.name}`);
  }

  const deletedWorker = await callCloudflare({
    method: "DELETE",
    path: `/workers/scripts/${environment.workerName}?force=true`,
    expectedStatuses: [404],
  });
  console.log(
    deletedWorker.status === 404 ? `No Worker ${environment.workerName}.` : `Deleted Worker ${environment.workerName}.`,
  );

  const databaseId = await findDatabaseId(environment.databaseName);

  if (databaseId === null) {
    console.log(`No D1 ${environment.databaseName}.`);
  } else {
    await callCloudflare({ method: "DELETE", path: `/d1/database/${databaseId}` });
    console.log(`Deleted D1 ${environment.databaseName}.`);
  }
}
