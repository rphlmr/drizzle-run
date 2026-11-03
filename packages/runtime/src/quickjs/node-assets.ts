import { readFile } from "node:fs/promises";

import { defaultGuestSelection, guestAssetPrefix, type GuestSelection } from "./selection.ts";
import type { ExecutionAssets } from "./worker-contract.ts";
import { CatalogSchema } from "./worker-contract.ts";

/** Load local build artifacts. No registry or CDN access occurs during execution. */
export async function loadNodeAssets({
  directory,
  signal,
  selection = defaultGuestSelection,
  verifyAsset,
}: {
  directory: URL;
  signal?: AbortSignal;
  selection?: GuestSelection;
  verifyAsset?: (name: string, bytes: Uint8Array) => Promise<Uint8Array>;
}): Promise<ExecutionAssets> {
  async function loadAsset(name: string) {
    const bytes = await readFile(new URL(name, directory), { signal });

    return new Uint8Array(verifyAsset ? await verifyAsset(name, bytes) : bytes);
  }

  const [bundle, wasmBytes, compilerBytes, encoding, url, catalog] = await Promise.all([
    loadAsset(`${guestAssetPrefix(selection)}/execution.guest.js`).then((bytes) => new TextDecoder().decode(bytes)),
    loadAsset("quickjs.wasm"),
    loadAsset("esbuild.wasm"),
    loadAsset("encoding.so"),
    loadAsset("url.so"),
    loadAsset(`${guestAssetPrefix(selection)}/catalog.json`).then((bytes) => new TextDecoder().decode(bytes)),
  ]);

  return {
    bundle,
    wasmBytes,
    compilerBytes,
    extensionBytes: [
      { name: "encoding", bytes: encoding },
      { name: "url", bytes: url },
    ],
    catalog: CatalogSchema.parse(JSON.parse(catalog)),
  };
}
