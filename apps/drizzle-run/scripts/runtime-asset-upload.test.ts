import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RuntimeAsset } from "../worker/runtime-assets.generated.ts";
import { uploadRuntimeAssets } from "./runtime-asset-upload.ts";

const runFile = promisify(execFile);
const bucket = "drizzle-run-assets-test";
const timeoutMs = 60_000;

const require = createRequire(import.meta.url);
const wranglerPackage = require.resolve("wrangler/package.json");
const wrangler = resolve(dirname(wranglerPackage), require(wranglerPackage).bin.wrangler);

let workDir: string;
let assetDir: string;
let stateDir: string;
let fakeAssets: RuntimeAsset[];

/**
 * Writes a fake asset file under its content-addressed key, and returns its inventory entry.
 */
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

/**
 * Uploads the fake inventory to the test bucket, and returns the asset names it stored.
 */
function uploadFakeAssets() {
  return uploadRuntimeAssets({
    assets: fakeAssets,
    assetDir,
    bucket,
    storage: { kind: "local", stateDir },
    log: () => {},
  });
}

/**
 * Runs one `wrangler r2 object` command on the test bucket, to change it behind the uploader's back.
 */
async function runR2Object(command: "delete" | "put", key: string, extraArgs: string[] = []) {
  await runFile(
    process.execPath,
    [wrangler, "r2", "object", command, `${bucket}/${key}`, ...extraArgs, "--local", "--persist-to", stateDir],
    { env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" } },
  );
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "drizzle-run-upload-test-"));
  assetDir = join(workDir, "assets");
  stateDir = join(workDir, "state");
  fakeAssets = await Promise.all([
    makeFakeAsset({ name: "guests/fake-orm.tar.gz", content: "fake guest" }),
    makeFakeAsset({ name: "engines/fake-engine.tar.gz", content: "fake engine" }),
  ]);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("uploadRuntimeAssets", () => {
  it(
    "should upload every asset into an empty bucket",
    async () => {
      expect((await uploadFakeAssets()).toSorted()).toEqual(fakeAssets.map((asset) => asset.name).toSorted());
    },
    timeoutMs,
  );

  it(
    "should skip assets the bucket already holds intact",
    async () => {
      expect(await uploadFakeAssets()).toEqual([]);
    },
    timeoutMs,
  );

  it(
    "should upload a deleted asset again",
    async () => {
      const [deletedAsset] = fakeAssets;

      await runR2Object("delete", deletedAsset.key);

      expect(await uploadFakeAssets()).toEqual([deletedAsset.name]);
      expect(await uploadFakeAssets()).toEqual([]);
    },
    timeoutMs,
  );

  it(
    "should upload an asset whose stored bytes were replaced",
    async () => {
      const [replacedAsset] = fakeAssets;
      const wrongFile = join(workDir, "wrong-bytes.bin");

      await writeFile(wrongFile, "not the inventory bytes");
      await runR2Object("put", replacedAsset.key, ["--file", wrongFile]);

      expect(await uploadFakeAssets()).toEqual([replacedAsset.name]);
      expect(await uploadFakeAssets()).toEqual([]);
    },
    timeoutMs,
  );

  it(
    "should refuse to upload a local file that does not match the inventory",
    async () => {
      const [corruptedAsset] = fakeAssets;

      await runR2Object("delete", corruptedAsset.key);
      await writeFile(join(assetDir, corruptedAsset.key), "corrupted local file");

      await expect(uploadFakeAssets()).rejects.toThrow(
        `Runtime asset failed local integrity validation: ${corruptedAsset.name}`,
      );
    },
    timeoutMs,
  );
});
