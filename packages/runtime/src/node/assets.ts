import { mkdir, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { runtimeAssets } from "../assets/inventory.generated.ts";

/** Copy the complete SDK asset tree to a static directory; pass its public URL as `assetBaseUrl`. */
export async function copyRuntimeAssets(directory: string): Promise<void> {
  for (const asset of runtimeAssets) {
    const target = resolve(directory, asset.key);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(new URL(`../assets/${asset.key}`, import.meta.url), target);
  }
}
