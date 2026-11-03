import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runtimeAssets } from "../src/assets/inventory.generated.ts";

for (const asset of runtimeAssets) {
  const source = new URL(`../../../.cache/runtime-assets/r2/${asset.key}`, import.meta.url);
  const bytes = await readFile(source);

  if (bytes.byteLength !== asset.size || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
    throw new Error(`Runtime asset does not match its inventory: ${asset.key}`);
  }

  const target = new URL(`../dist/assets/${asset.key}`, import.meta.url);
  await mkdir(dirname(fileURLToPath(target)), { recursive: true });
  await copyFile(source, target);
}

// Bundled worker entrypoints must replace the unbundled TypeScript output, never the reverse.
await cp(
  new URL("../../../.cache/runtime-assets/quickjs/", import.meta.url),
  new URL("../dist/quickjs/", import.meta.url),
  { recursive: true },
);
