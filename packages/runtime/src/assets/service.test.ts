import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import { validateRuntimeAssetDescriptor, type RuntimeAsset } from "./contract.ts";
import { fetchRuntimeAsset } from "./service.ts";

const encoder = new TextEncoder();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runtime asset descriptors", () => {
  it("should accept complete compressed metadata and clone the descriptor", () => {
    const compressed = createCompressedAsset(new Uint8Array([1, 2, 3]));
    const validated = validateRuntimeAssetDescriptor(compressed);
    expect(validated).toEqual(compressed);
    expect(validated).not.toBe(compressed);
  });

  const compressedMetadataMessage = "Compressed runtime asset requires valid original size and SHA-256 metadata";
  const uncompressedMetadataMessage = "Uncompressed runtime assets cannot declare original-byte metadata";

  it.each([
    { metadata: { compression: "gzip", rawSize: 3 }, message: compressedMetadataMessage },
    { metadata: { compression: "gzip", rawSha256: "a".repeat(64) }, message: compressedMetadataMessage },
    { metadata: { compression: "brotli", rawSize: 3, rawSha256: "a".repeat(64) }, message: compressedMetadataMessage },
    { metadata: { rawSize: 3 }, message: uncompressedMetadataMessage },
    { metadata: { rawSha256: "a".repeat(64) }, message: uncompressedMetadataMessage },
  ])("rejects incomplete or unsupported compression metadata %#", ({ metadata, message }) => {
    const asset = { ...createAsset(new Uint8Array([1])), ...metadata } as RuntimeAsset;

    expect(() => validateRuntimeAssetDescriptor(asset)).toThrow(message);
  });

  it("should reject unsafe URLs, invalid hashes, and out-of-range sizes", () => {
    const base = createAsset(new Uint8Array([1]));

    expect(() => validateRuntimeAssetDescriptor({ ...base, url: "javascript:alert(1)" })).toThrow("descriptor");
    expect(() =>
      validateRuntimeAssetDescriptor({
        ...base,
        url: "https://user:pass@example.test/file",
      }),
    ).toThrow("descriptor");
    expect(() => validateRuntimeAssetDescriptor({ ...base, sha256: "bad" })).toThrow("descriptor");
    expect(() => validateRuntimeAssetDescriptor({ ...base, size: 256 * 1024 * 1024 + 1 })).toThrow("descriptor");
  });
});

describe("fetchRuntimeAsset", () => {
  it("should verify downloaded bytes and report bounded progress", async () => {
    const bytes = encoder.encode("runtime asset");
    const asset = await createAssetAsync(bytes);
    const fetchStub = vi.fn(async () => new Response(bytes.slice().buffer));
    vi.stubGlobal("fetch", fetchStub);
    const progress: Array<[number, number]> = [];

    const result = await fetchRuntimeAsset(asset, new AbortController().signal, (downloaded, total) => {
      progress.push([downloaded, total]);
    });

    expect(result).toEqual(bytes);
    expect(progress.at(-1)).toEqual([bytes.byteLength, bytes.byteLength]);
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it("should verify compressed bytes and bounded decompressed bytes", async () => {
    const raw = encoder.encode("wasm runtime bytes");
    const stored = new Uint8Array(gzipSync(raw));
    const asset = await createCompressedAssetAsync(stored, raw);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stored.slice().buffer)),
    );

    await expect(fetchRuntimeAsset(asset, new AbortController().signal)).resolves.toEqual(raw);
  });

  it("should decompress a large gzip asset delivered across bounded source chunks", async () => {
    const raw = randomBytes(180_000);
    const stored = new Uint8Array(gzipSync(raw));
    const asset = await createCompressedAssetAsync(stored, raw);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stored.slice().buffer)),
    );

    expect(stored.byteLength).toBeGreaterThan(65_536);

    await expect(fetchRuntimeAsset(asset, new AbortController().signal)).resolves.toEqual(raw);
  });

  it("should reject invalid compression descriptors before issuing a request", async () => {
    const asset = {
      ...createAsset(encoder.encode("stored")),
      compression: "gzip",
      rawSize: 16,
    } as RuntimeAsset;
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);

    await expect(fetchRuntimeAsset(asset, new AbortController().signal)).rejects.toThrow("metadata");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("should cancel a stored response when it exceeds its admitted size", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(32));
      },
      cancel() {
        cancelled = true;
      },
    });
    const asset = { ...createAsset(encoder.encode("x")), size: 1 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );

    await expect(fetchRuntimeAsset(asset, new AbortController().signal)).rejects.toThrow("exceeds its admitted size");
    expect(cancelled).toBe(true);
  });

  it("should cancel decompression when the declared original size is exceeded", async () => {
    const raw = randomBytes(180_000);
    const stored = new Uint8Array(gzipSync(raw));
    const storedAsset = await createCompressedAssetAsync(stored, raw);
    const asset = { ...storedAsset, rawSize: 10 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stored.slice().buffer)),
    );

    await expect(fetchRuntimeAsset(asset, new AbortController().signal)).rejects.toThrow(
      "Decompressed runtime asset exceeds",
    );
  });

  it("should reject short responses and content hash mismatches", async () => {
    const expected = createAsset(encoder.encode("expected"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(encoder.encode("short").buffer)),
    );

    await expect(fetchRuntimeAsset(expected, new AbortController().signal)).rejects.toThrow(
      "does not match its admitted size",
    );

    const wrongHash = { ...expected, size: 5 };
    await expect(fetchRuntimeAsset(wrongHash, new AbortController().signal)).rejects.toThrow("integrity check failed");
  });
});

function createAsset(bytes: Uint8Array): RuntimeAsset {
  return {
    url: "/runtime-assets/asset.bin",
    digest: "a".repeat(64),
    sha256: "b".repeat(64),
    size: bytes.byteLength,
  };
}

function createCompressedAsset(raw: Uint8Array): RuntimeAsset {
  return {
    ...createAsset(new Uint8Array([1, 2, 3])),
    compression: "gzip",
    rawSize: raw.byteLength,
    rawSha256: "c".repeat(64),
  };
}

async function createCompressedAssetAsync(stored: Uint8Array, raw: Uint8Array): Promise<RuntimeAsset> {
  return {
    ...(await createAssetAsync(stored)),
    compression: "gzip",
    rawSize: raw.byteLength,
    rawSha256: await sha256(raw),
  };
}

async function createAssetAsync(bytes: Uint8Array): Promise<RuntimeAsset> {
  return {
    ...createAsset(bytes),
    sha256: await sha256(bytes),
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));

  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

function randomBytes(size: number): Uint8Array {
  let state = 0x1234_5678;

  return Uint8Array.from({ length: size }, () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state >>> 24;
  });
}
