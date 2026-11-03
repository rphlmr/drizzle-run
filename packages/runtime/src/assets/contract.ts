import * as z from "zod/mini";

import { plainRecord } from "../schema.ts";

/**
 * A fetched runtime file, checked against its size and SHA-256
 *
 * A gzip asset also carries the size and SHA-256 of its original bytes.
 */
export interface RuntimeAsset {
  url: string;
  digest: string;
  sha256: string;
  size: number;
  compression?: "gzip";
  rawSize?: number;
  rawSha256?: string;
}

const MAX_STORED_ASSET_BYTES = 256 * 1024 * 1024; // 256 MiB
const MAX_DECOMPRESSED_ASSET_BYTES = 256 * 1024 * 1024; // 256 MiB

const sha256Pattern = /^[a-f0-9]{64}$/;
const invalidDescriptor = "Invalid trusted runtime asset descriptor";
const invalidCompressedMetadata = "Compressed runtime asset requires valid original size and SHA-256 metadata";
const invalidUncompressedMetadata = "Uncompressed runtime assets cannot declare original-byte metadata";

function sha256Text(message: string) {
  return z.string({ error: message }).check(z.regex(sha256Pattern, { error: message }));
}

function byteSize(message: string, maxBytes: number) {
  return z
    .number({ error: message })
    .check(z.int({ error: message }), z.positive({ error: message }), z.lte(maxBytes, { error: message }));
}

/** A plain HTTP(S) URL, relative to the page, with no credentials or fragment. */
const AssetUrlSchema = z.string({ error: invalidDescriptor }).check(
  z.superRefine((text, payload) => {
    let url: URL;

    try {
      url = new URL(text, globalThis.location?.href ?? "https://drizzle.run/");
    } catch {
      payload.issues.push({ code: "custom", input: text, message: "Invalid trusted runtime asset URL" });
      return;
    }

    if (!/^https?:$/.test(url.protocol) || url.username !== "" || url.password !== "" || url.hash !== "") {
      payload.issues.push({ code: "custom", input: text, message: invalidDescriptor });
    }
  }),
);

const runtimeAssetShape = {
  url: AssetUrlSchema,
  digest: sha256Text(invalidDescriptor),
  sha256: sha256Text(invalidDescriptor),
  size: byteSize(invalidDescriptor, MAX_STORED_ASSET_BYTES),
  compression: z.optional(z.literal("gzip", { error: invalidCompressedMetadata })),
  rawSize: z.optional(byteSize(invalidCompressedMetadata, MAX_DECOMPRESSED_ASSET_BYTES)),
  rawSha256: z.optional(sha256Text(invalidCompressedMetadata)),
};

/** The original-byte metadata of an asset: required when it is compressed, absent otherwise. */
type CompressionMetadata = Pick<RuntimeAsset, "compression" | "rawSize" | "rawSha256">;

function hasNoOriginalMetadataUnlessCompressed(asset: CompressionMetadata): boolean {
  return asset.compression !== undefined || (asset.rawSize === undefined && asset.rawSha256 === undefined);
}

function hasOriginalMetadataWhenCompressed(asset: CompressionMetadata): boolean {
  return asset.compression === undefined || (asset.rawSize !== undefined && asset.rawSha256 !== undefined);
}

const compressionMetadataChecks = [
  z.refine<CompressionMetadata>(hasNoOriginalMetadataUnlessCompressed, { error: invalidUncompressedMetadata }),
  z.refine<CompressionMetadata>(hasOriginalMetadataWhenCompressed, { error: invalidCompressedMetadata }),
];

/**
 * A runtime asset descriptor
 *
 * Fails when the URL is not plain HTTP(S), a digest is not SHA-256 hex, the size is out of bounds, or the
 * compression metadata is incomplete.
 */
export const RuntimeAssetSchema = z.pipe(
  plainRecord(invalidDescriptor),
  z.object(runtimeAssetShape).check(...compressionMetadataChecks),
) satisfies z.ZodMiniType<RuntimeAsset>;

function parseOrThrow<Output>(schema: z.ZodMiniType<Output>, input: unknown, fallbackMessage: string): Output {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new TypeError(result.error.issues[0]?.message ?? fallbackMessage);
  }

  return result.data;
}

/**
 * Validate one runtime asset descriptor and return a copy of its known fields
 *
 * Throws a `TypeError` when the URL is not plain HTTP(S), a digest is not SHA-256 hex, the size is out of bounds,
 * or the compression metadata is incomplete.
 */
export function validateRuntimeAssetDescriptor(asset: unknown): RuntimeAsset {
  return parseOrThrow(RuntimeAssetSchema, asset, invalidDescriptor);
}
