import { runtimeAssets } from "./runtime-assets.generated";

/** A runtime asset the worker may serve: its R2 key, type, checksums and size. */
export interface ApprovedRuntimeAsset {
  objectKey: string;
  contentType: string;
  sha256: string;
  md5: string;
  size: number;
}

/** The approved runtime assets, by `<digest>/<name>` address. */
export const approvedRuntimeAssetInventory: Readonly<Record<string, ApprovedRuntimeAsset>> = Object.freeze(
  Object.fromEntries(
    runtimeAssets.map(({ digest, name, key, contentType, sha256, md5, size }) => [
      `${digest}/${name}`,
      { objectKey: key, contentType, sha256, md5, size },
    ]),
  ),
);
