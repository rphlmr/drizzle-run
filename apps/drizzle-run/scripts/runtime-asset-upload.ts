import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { R2Bucket } from "@cloudflare/workers-types";

import type { RuntimeAsset } from "../worker/runtime-assets.generated.ts";
import { type BucketTarget, runR2ObjectCommand, withBucketBinding } from "./runtime-asset-bucket.ts";
import { createDeploymentRecord } from "./runtime-asset-deployments.ts";

interface UploadOptions extends BucketTarget {
  assets: readonly RuntimeAsset[];
  assetDir: string;
  gitCommit: string;
  preview?: string;
  log: (line: string) => void;
}

function hashOf(algorithm: string, bytes: Uint8Array) {
  return createHash(algorithm).update(bytes).digest("hex");
}

/**
 * Reads one asset file and checks it against the inventory, so nothing is written unless every file matches.
 */
async function readCheckedAsset(assetDir: string, asset: RuntimeAsset) {
  const file = join(assetDir, asset.key);
  const bytes = await readFile(file);

  if (bytes.length !== asset.size || hashOf("sha256", bytes) !== asset.sha256 || hashOf("md5", bytes) !== asset.md5) {
    throw new Error(`Runtime asset failed local integrity validation: ${asset.name}`);
  }

  return { asset, file };
}

/**
 * Whether the bucket holds the asset with the inventory's size and MD5, the test the Worker applies on every read.
 * A missing object, or one without an MD5 checksum, is not intact.
 */
async function isStoredIntact(bucketBinding: R2Bucket, asset: RuntimeAsset) {
  const object = await bucketBinding.head(asset.key);

  if (object === null || object.checksums.md5 === undefined) {
    return false;
  }

  return object.size === asset.size && Buffer.from(object.checksums.md5).toString("hex") === asset.md5;
}

/**
 * Returns the inventory assets the bucket does not hold intact. The bucket itself is the record, so an object deleted
 * or replaced since the last upload is uploaded again.
 */
async function getMissingAssets({ assets, bucket, storage }: Pick<UploadOptions, "assets" | "bucket" | "storage">) {
  return withBucketBinding({ bucket, storage }, async (bucketBinding) => {
    const intact = await Promise.all(assets.map((asset) => isStoredIntact(bucketBinding, asset)));

    return assets.filter((_, index) => !intact[index]);
  });
}

/**
 * Stores the inventory's deployment record, after its assets, so a record never names an object the bucket lacks.
 */
async function putDeploymentRecord({
  assets,
  gitCommit,
  preview,
  bucket,
  storage,
}: Omit<UploadOptions, "assetDir" | "log">) {
  const { key, body } = createDeploymentRecord({
    assetKeys: assets.map((asset) => asset.key),
    gitCommit,
    uploadedAt: new Date(),
    preview,
  });
  const recordDir = await mkdtemp(join(tmpdir(), "drizzle-run-deployment-"));

  try {
    const file = join(recordDir, "record.json");

    await writeFile(file, body);
    await runR2ObjectCommand({
      command: "put",
      objectPath: `${bucket}/${key}`,
      args: ["--file", file, "--content-type", "application/json"],
      storage,
    });
  } finally {
    await rm(recordDir, { recursive: true, force: true });
  }

  return key;
}

/**
 * Upload runtime assets to R2
 *
 * Puts every inventory asset the bucket does not hold intact with `wrangler r2 object put`, and skips the rest, so a
 * repeat run uploads only new versions. Local files are checked against the inventory before the first write. Then it
 * stores the inventory's deployment record (`deployments/<inventory id>.json`, or `deployments/<inventory id>.<preview>.json`
 * for a pull request preview), which keeps these assets through `prune-runtime-assets.ts` while the deployment is among
 * the newest, or is its open preview's newest.
 *
 * @param options.assets - The inventory: each asset's R2 key, name, content type, size, SHA-256 and MD5
 * @param options.assetDir - The folder holding each asset's file at its key
 * @param options.bucket - The R2 bucket name
 * @param options.storage - `{ kind: "local", stateDir }` for Wrangler's local storage (the folder `--persist-to`
 *   takes), or `{ kind: "remote", accountId }` for the account's bucket
 * @param options.gitCommit - The commit the inventory was built from, written in the deployment record
 * @param options.preview - The pull request preview it deploys, such as `pr-12`, written in the deployment record
 * @param options.log - Receives one line per step
 * @returns The names of the assets it stored
 */
export async function uploadRuntimeAssets({
  assets,
  assetDir,
  bucket,
  storage,
  gitCommit,
  preview,
  log,
}: UploadOptions) {
  const missingAssets = await getMissingAssets({ assets, bucket, storage });

  log(
    `Runtime assets: ${assets.length - missingAssets.length} of ${assets.length} already stored, ` +
      `${missingAssets.length} to upload`,
  );

  const checkedAssets = await Promise.all(missingAssets.map((asset) => readCheckedAsset(assetDir, asset)));

  for (const { asset, file } of checkedAssets) {
    await runR2ObjectCommand({
      command: "put",
      objectPath: `${bucket}/${asset.key}`,
      args: ["--file", file, "--content-type", asset.contentType],
      storage,
    });
    log(`Stored ${asset.name} (${asset.size} bytes)`);
  }

  const recordKey = await putDeploymentRecord({ assets, gitCommit, preview, bucket, storage });

  log(`Recorded deployment ${recordKey}`);

  return missingAssets.map((asset) => asset.name);
}
