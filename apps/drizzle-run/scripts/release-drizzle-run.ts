import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { unstable_readConfig } from "wrangler";

import { runRelease } from "./release-machine.ts";
import { resolveBucketTarget } from "./runtime-asset-bucket.ts";
import { assertPreviewName, parsePreviewNames } from "./runtime-asset-deployments.ts";
import { verifyDeployedRuntimeAssets } from "./runtime-asset-verify.ts";

// Releases the checked-out commit to production. `--config wrangler.deploy.json` releases to a deploy environment
// instead. `--verify-timeout` is in seconds (default 30).
//
//   pnpm --filter @drizzle-run/app run release --bucket <bucket> --account-id <account-id> --url <https origin>
//     [--config <wrangler config>] [--keep <records>] [--preview <name>] [--open-previews <names>]
//     [--verify-timeout <seconds>]

const rootDir = fileURLToPath(new URL("../../..", import.meta.url));
const appDir = resolve(rootDir, "apps/drizzle-run");
const scriptsDir = resolve(appDir, "scripts");

const { values } = parseArgs({
  options: {
    bucket: { type: "string" },
    "account-id": { type: "string" },
    url: { type: "string" },
    keep: { type: "string", default: "1" },
    preview: { type: "string" },
    "open-previews": { type: "string" },
    config: { type: "string", default: "wrangler.jsonc" },
    "verify-timeout": { type: "string", default: "30" },
  },
});

if (values.bucket === undefined || values["account-id"] === undefined || values.url === undefined) {
  throw new Error(
    "Pass --bucket <runtime-assets-bucket> --account-id <account-id> --url <https origin of the Worker>.",
  );
}

// Called only to validate the bucket name and account ID, as the upload does.
resolveBucketTarget({ remote: true, local: false, bucket: values.bucket, "account-id": values["account-id"] }, "");

if (!/^[1-9][0-9]*$/.test(values["verify-timeout"])) {
  throw new Error(`Expected --verify-timeout to be a whole number of seconds, but got ${values["verify-timeout"]}`);
}

if (!/^[1-9][0-9]*$/.test(values.keep)) {
  throw new Error(`Expected --keep to be a whole number of at least 1, but got ${values.keep}`);
}

// Checked before the build, so a bad name stops the release before anything is uploaded.
const preview = values.preview === undefined ? undefined : assertPreviewName(values.preview);
const openPreviews = values["open-previews"] === undefined ? undefined : parsePreviewNames(values["open-previews"]);

const origin = new URL(values.url);

if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") {
  throw new Error(`Expected --url to be an https origin such as https://run.example.com, but got ${values.url}`);
}

// Relative to the app, as the package script runs it.
const wranglerConfigPath = resolve(appDir, values.config);

const wranglerConfig: {
  d1_databases: { binding: string; database_id?: string }[];
  r2_buckets: { binding: string; bucket_name?: string }[];
} = unstable_readConfig({ config: wranglerConfigPath });

const playgroundsDatabaseId = wranglerConfig.d1_databases.find(
  (database) => database.binding === "PLAYGROUNDS",
)?.database_id;

if (playgroundsDatabaseId === undefined || /^[0-]+$/.test(playgroundsDatabaseId)) {
  throw new Error(
    `Expected ${values.config} to bind PLAYGROUNDS to a deployed D1 database id, but got ${playgroundsDatabaseId}`,
  );
}

const runtimeAssetsBucket = wranglerConfig.r2_buckets.find(
  (bucket) => bucket.binding === "RUNTIME_ASSETS",
)?.bucket_name;

if (runtimeAssetsBucket !== values.bucket) {
  throw new Error(
    `Expected --bucket to be ${values.config}'s RUNTIME_ASSETS bucket ${runtimeAssetsBucket}, but got ${values.bucket}`,
  );
}

const bucketArgs = ["--remote", "--bucket", values.bucket, "--account-id", values["account-id"]];
const accountId = values["account-id"];
// Every preview's config has the same path, so Turborepo also hashes its content: a cached build for another D1 or
// Worker name is never restored.
const childEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: values["account-id"],
  DRIZZLE_RUN_WRANGLER_CONFIG: wranglerConfigPath,
  DRIZZLE_RUN_WRANGLER_CONFIG_SHA256: createHash("sha256").update(readFileSync(wranglerConfigPath)).digest("hex"),
};
// The build runs every build tool and plugin, so it never gets the token.
const { CLOUDFLARE_API_TOKEN: _apiToken, ...buildEnvironment } = childEnvironment;

/**
 * Runs a command with the terminal's output, and rejects when it exits with anything but 0.
 */
function runCommand(command: string, args: string[], cwd: string, env = childEnvironment) {
  return new Promise<void>((resolveProcess, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveProcess();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with ${signal ?? `code ${code}`}`));
    });
  });
}

function log(line: string) {
  process.stdout.write(`${line}\n`);
}

const snapshot = await runRelease({
  build: async () => {
    log("Release: building");
    await runCommand("pnpm", ["run", "build"], rootDir, buildEnvironment);
  },
  upload: async () => {
    log("Release: uploading runtime assets");
    await runCommand(
      process.execPath,
      [
        "--experimental-strip-types",
        resolve(scriptsDir, "upload-runtime-assets.ts"),
        ...bucketArgs,
        ...(preview === undefined ? [] : ["--preview", preview]),
      ],
      rootDir,
    );
  },
  migrate: async () => {
    log(`Release: applying the D1 migrations to ${playgroundsDatabaseId}`);
    await runCommand(
      process.execPath,
      [resolve(scriptsDir, "migrate-d1.ts"), "--remote", "--account-id", accountId, "--config", wranglerConfigPath],
      appDir,
    );
  },
  deploy: async () => {
    log("Release: deploying the Worker");
    await runCommand("pnpm", ["exec", "wrangler", "deploy"], appDir);
  },
  verify: async () => {
    log(`Release: verifying runtime assets through ${origin.origin}`);

    // Imported after the build, which writes the inventory.
    const inventoryUrl = pathToFileURL(resolve(appDir, "worker/runtime-assets.generated.ts"));
    const { runtimeAssets } = await import(inventoryUrl.href);

    await verifyDeployedRuntimeAssets({
      origin: origin.origin,
      assets: runtimeAssets,
      fetchAsset: fetch,
      propagationTimeoutMs: Number(values["verify-timeout"]) * 1000,
      log,
    });
  },
  prune: async () => {
    log("Release: deleting runtime assets no other deployment needs");
    await runCommand(
      process.execPath,
      [
        "--experimental-strip-types",
        resolve(scriptsDir, "prune-runtime-assets.ts"),
        ...bucketArgs,
        "--keep",
        values.keep,
        // One argument, so an empty list (no open pull request) is still a value.
        ...(openPreviews === undefined ? [] : [`--open-previews=${openPreviews.join(",")}`]),
        "--delete",
      ],
      rootDir,
    );
  },
});

if (snapshot.matches("failed")) {
  const { failedStep, error } = snapshot.context;

  throw new Error(`Release stopped at the ${failedStep} step; nothing after it ran`, { cause: error });
}

log(`Released ${origin.origin}`);
