import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import * as z from "zod/mini";

import type { RuntimeAsset } from "../src/assets/contract.ts";

const runtimeDirectory = fileURLToPath(new URL("../", import.meta.url));
const cacheDirectory = resolve(runtimeDirectory, "../../.cache/runtime-assets");
const quickjsDirectory = resolve(cacheDirectory, "quickjs");
const generatedDirectory = resolve(runtimeDirectory, "src/assets");
const ArtifactSchema = z.object({ artifactId: z.string() });
const inventory: Array<RuntimeAsset & { key: string; name: string; contentType: string; md5: string }> = [];
const declarationArtifacts: Record<string, RuntimeAsset> = {};

await rm(resolve(cacheDirectory, "r2"), { recursive: true, force: true });

function hash(bytes: Uint8Array | string, algorithm = "sha256") {
  return createHash(algorithm).update(bytes).digest("hex");
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;

    if (entry.isDirectory()) {
      files.push(...(await listFiles(resolve(directory, entry.name), `${name}/`)));
    } else if (entry.isFile() && !/\.(?:map|ts)$/.test(name)) {
      files.push(name);
    }
  }

  return files.toSorted();
}

async function stageAsset({
  name,
  digest,
  bytes,
  raw,
}: {
  name: string;
  digest: string;
  bytes: Uint8Array;
  raw?: Uint8Array;
}) {
  const key = `${digest}/${name}`;
  const path = resolve(cacheDirectory, "r2", key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  const contentTypes: Record<string, string> = {
    ".js": "application/javascript",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".gz": "application/gzip",
  };
  const asset: RuntimeAsset = {
    url: `/runtime-assets/${key}`,
    digest,
    sha256: hash(bytes),
    size: bytes.byteLength,
    ...(raw ? { compression: "gzip" as const, rawSha256: hash(raw), rawSize: raw.byteLength } : {}),
  };
  inventory.push({
    ...asset,
    key,
    name,
    contentType: contentTypes[extname(name)] ?? "application/octet-stream",
    md5: hash(bytes, "md5"),
  });

  return asset;
}

// Hash the directory as one unit so all worker-relative URLs share an immutable address.
const files = await Promise.all(
  (await listFiles(quickjsDirectory)).map(async (name) => ({
    name,
    bytes: await readFile(resolve(quickjsDirectory, name)),
  })),
);
const digest = hash(JSON.stringify(files.map(({ name, bytes }) => [name, hash(bytes)])));

for (const { name, bytes } of files) {
  await stageAsset({ name: `quickjs/${name}`, digest, bytes });
}

const declarationDirectory = resolve(runtimeDirectory, "artifacts/declarations");

for (const name of (await readdir(declarationDirectory)).filter((name) => name.endsWith(".json")).toSorted()) {
  const raw = await readFile(resolve(declarationDirectory, name));
  const { artifactId } = ArtifactSchema.parse(JSON.parse(raw.toString("utf8")));
  declarationArtifacts[artifactId] = await stageAsset({
    name: `types/${name}.gz`,
    digest: hash(raw),
    bytes: gzipSync(raw, { level: 9 }),
    raw,
  });
}

await mkdir(generatedDirectory, { recursive: true });
await writeFile(
  resolve(generatedDirectory, "configuration.generated.ts"),
  `import type { RuntimeAsset } from "./contract.ts";\n\n/** Content-addressed QuickJS directory relative to the consumer's asset base URL. */\nexport const quickjsAssetDirectory = ${JSON.stringify(`${digest}/quickjs/`)};\n\nexport const declarationArtifactAssets: Readonly<Record<string, RuntimeAsset>> = Object.freeze(${JSON.stringify(declarationArtifacts, null, 2)});\n`,
);
await writeFile(
  resolve(generatedDirectory, "inventory.generated.ts"),
  `/** Generated inventory shared by the SDK and the application asset server. */\nexport interface RuntimeAsset {\n readonly digest: string;\n readonly name: string;\n readonly key: string;\n readonly contentType: string;\n readonly sha256: string;\n readonly md5: string;\n readonly size: number;\n readonly compression?: "gzip";\n readonly rawSha256?: string;\n readonly rawSize?: number;\n}\n\nexport const runtimeAssets: readonly RuntimeAsset[] = Object.freeze(${JSON.stringify(
    inventory.map(({ url: _url, ...asset }) => asset),
    null,
    2,
  )});\n`,
);
console.log(`Prepared ${inventory.length} immutable runtime assets (${digest}).`);
