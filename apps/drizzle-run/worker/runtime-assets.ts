import { approvedRuntimeAssetInventory, type ApprovedRuntimeAsset } from "./asset-inventory";
import { toHex } from "./hex-digest";
import { createApiError, isNotModified } from "./http";
import type { R2Bucket } from "./platform";

/** The runtime assets the worker may serve, by address. */
export interface RuntimeAssetInventory {
  readonly [address: string]: ApprovedRuntimeAsset | undefined;
}

function validateAssetPath(path: string): string | undefined {
  if (path.includes("%")) {
    return undefined;
  }

  const segments = path.split("/");

  if (
    segments.some(
      (segment) => !segment || segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\0"),
    )
  ) {
    return undefined;
  }

  return segments.join("/");
}

function digestHeader(hex: string): string {
  const bytes = Uint8Array.from(hex.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return `sha-256=:${btoa(binary)}:`;
}

function toChecksumHex(checksum: ArrayBuffer | undefined): string | undefined {
  if (checksum === undefined) {
    return undefined;
  }

  return toHex(checksum);
}

/** Serves an approved runtime asset from R2, checking its size and checksum, with immutable cache headers. */
export async function serveRuntimeAsset(
  request: Request,
  bucket: R2Bucket,
  pathname: string,
  inventory: RuntimeAssetInventory = approvedRuntimeAssetInventory,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  const routePath = pathname.replace(/^\/runtime-assets\//, "");
  const separator = routePath.indexOf("/");

  if (separator < 1 || separator === routePath.length - 1) {
    return new Response(null, { status: 404 });
  }

  const digest = routePath.slice(0, separator);
  const assetPath = validateAssetPath(routePath.slice(separator + 1));

  if (!/^[a-f0-9]{64}$/.test(digest) || assetPath === undefined) {
    return new Response(null, { status: 404 });
  }

  const asset = inventory[`${digest}/${assetPath}`];

  if (asset === undefined || !/^[a-f0-9]{64}$/.test(asset.sha256) || !/^[a-f0-9]{32}$/.test(asset.md5)) {
    return new Response(null, { status: 404 });
  }

  let object;

  try {
    object = await bucket.get(asset.objectKey);
  } catch {
    return createApiError(503, "asset_storage_unavailable", "The runtime asset is temporarily unavailable.");
  }

  if (object === null) {
    return new Response(null, { status: 404 });
  }

  // R2 computes the MD5 of every single-part upload; the inventory says what it must be.
  if (toChecksumHex(object.checksums?.md5) !== asset.md5 || object.size !== asset.size) {
    return createApiError(502, "asset_integrity_mismatch", "The runtime asset failed its integrity check.");
  }

  const headers = new Headers({
    "Accept-Ranges": "none",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Digest": digestHeader(asset.sha256),
    "Content-Length": String(object.size),
    "Content-Type": asset.contentType,
    "Cross-Origin-Resource-Policy": "cross-origin",
    ETag: object.httpEtag,
    "X-Content-Type-Options": "nosniff",
  });

  if (isNotModified(request, object.httpEtag)) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}
