import { runtimeAssets } from "./inventory.generated.ts";
import { decodeRuntimeAsset } from "./service.ts";

/** Verify bytes against the package's immutable QuickJS asset inventory. */
export async function verifyQuickjsAsset(name: string, bytes: Uint8Array): Promise<Uint8Array> {
  const asset = runtimeAssets.find((asset) => asset.name === `quickjs/${name}`);

  if (!asset) {
    throw new Error(`QuickJS asset is absent from the package inventory: ${name}`);
  }

  return decodeRuntimeAsset({ ...asset, url: `/runtime-assets/${asset.key}` }, bytes);
}
