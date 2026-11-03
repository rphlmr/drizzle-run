import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { runtimeAssets } from "../worker/runtime-assets.generated.ts";
import { resolveBucketTarget } from "./runtime-asset-bucket.ts";
import { assertPreviewName } from "./runtime-asset-deployments.ts";
import { uploadRuntimeAssets } from "./runtime-asset-upload.ts";

// Uploads the generated runtime assets to R2: --local seeds the bucket `wrangler dev` reads, --remote writes the
// production bucket. `--preview pr-12` marks the deployment record as that pull request preview's.

const rootDir = fileURLToPath(new URL("../../..", import.meta.url));
const assetDir = resolve(rootDir, ".cache/runtime-assets/r2");
// DRIZZLE_RUN_STATE_DIR (relative to the repository) gives a second server in the same checkout its own storage.
const localState = resolve(rootDir, process.env.DRIZZLE_RUN_STATE_DIR ?? ".cache/cloudflare");

const { values } = parseArgs({
  options: {
    remote: { type: "boolean", default: false },
    local: { type: "boolean", default: false },
    bucket: { type: "string" },
    "account-id": { type: "string" },
    preview: { type: "string" },
  },
});

const { bucket, storage } = resolveBucketTarget(values, localState);
const preview = values.preview === undefined ? undefined : assertPreviewName(values.preview);

/**
 * Returns the checked-out commit for the deployment record, or "unknown" outside a Git checkout.
 */
function getGitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return "unknown";
  }
}

await uploadRuntimeAssets({
  assets: runtimeAssets,
  assetDir,
  bucket,
  storage,
  gitCommit: getGitCommit(),
  preview,
  log: (line) => process.stdout.write(`${line}\n`),
});
