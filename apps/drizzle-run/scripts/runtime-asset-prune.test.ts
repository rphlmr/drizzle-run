import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RuntimeAsset } from "../worker/runtime-assets.generated.ts";
import { withBucketBinding } from "./runtime-asset-bucket.ts";
import { pruneRuntimeAssets } from "./runtime-asset-prune.ts";
import { uploadRuntimeAssets } from "./runtime-asset-upload.ts";

const bucket = "drizzle-run-assets-prune-test";
const timeoutMs = 60_000;

let workDir: string;
let assetDir: string;
let storage: { kind: "local"; stateDir: string };
let oldEngine: RuntimeAsset;
let newEngine: RuntimeAsset;
let guest: RuntimeAsset;

async function makeFakeAsset({ name, content }: { name: string; content: string }) {
  const sha256 = createHash("sha256").update(content).digest("hex");
  const asset: RuntimeAsset = {
    digest: sha256,
    name,
    key: `${sha256}/${name}`,
    contentType: "application/octet-stream",
    sha256,
    md5: createHash("md5").update(content).digest("hex"),
    size: Buffer.byteLength(content),
  };
  const file = join(assetDir, asset.key);

  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);

  return asset;
}

function uploadDeployment(assets: RuntimeAsset[]) {
  return uploadRuntimeAssets({ assets, assetDir, bucket, storage, gitCommit: "test", log: () => {} });
}

// Two days after the uploads, past recentAssetWindowMs.
function prune(mode: "dry_run" | "delete", keepDeployments = 1) {
  return pruneRuntimeAssets({
    currentAssetKeys: [newEngine.key, guest.key],
    bucket,
    storage,
    keepDeployments,
    mode,
    log: () => {},
    now: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
  });
}

async function listBucketKeys() {
  return withBucketBinding({ bucket, storage }, async (bucketBinding) => {
    const page = await bucketBinding.list();

    return page.objects.map((object) => object.key).toSorted((left, right) => left.localeCompare(right));
  });
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "drizzle-run-prune-test-"));
  assetDir = join(workDir, "assets");
  storage = { kind: "local", stateDir: join(workDir, "state") };
  [oldEngine, newEngine, guest] = await Promise.all([
    makeFakeAsset({ name: "engines/fake-engine.tar.gz", content: "old engine" }),
    makeFakeAsset({ name: "engines/fake-engine.tar.gz", content: "new engine" }),
    makeFakeAsset({ name: "guests/fake-orm.tar.gz", content: "fake guest" }),
  ]);

  await uploadDeployment([oldEngine, guest]);
  await uploadDeployment([newEngine, guest]);
}, timeoutMs);

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("pruneRuntimeAssets", () => {
  it(
    "should delete nothing while the bucket has fewer records than the keep window",
    async () => {
      const keysBefore = await listBucketKeys();
      const { plan, deletedKeys } = await prune("delete", 3);

      expect(plan.recordShortfall).toBe(1);
      expect(deletedKeys).toEqual([]);
      expect(await listBucketKeys()).toEqual(keysBefore);
    },
    timeoutMs,
  );

  it(
    "should plan the old engine and its record without deleting them in a dry run",
    async () => {
      const keysBefore = await listBucketKeys();
      const { plan, deletedKeys } = await prune("dry_run");

      expect(plan.deletableObjects.map((object) => object.key)).toEqual([oldEngine.key]);
      expect(plan.staleRecords).toHaveLength(1);
      expect(deletedKeys).toEqual([]);
      expect(await listBucketKeys()).toEqual(keysBefore);
    },
    timeoutMs,
  );

  it(
    "should delete the old engine and its record, and keep the current deployment",
    async () => {
      const { plan, deletedKeys } = await prune("delete");
      const [keptRecord] = plan.keptRecords;
      const [staleRecord] = plan.staleRecords;

      expect(deletedKeys).toEqual([oldEngine.key, staleRecord.key]);
      expect(await listBucketKeys()).toEqual(
        [newEngine.key, guest.key, keptRecord.key].toSorted((left, right) => left.localeCompare(right)),
      );
      expect((await prune("dry_run")).plan.deletableObjects).toEqual([]);
    },
    timeoutMs,
  );
});
