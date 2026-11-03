import { createChunkedByteStream } from "./byte-stream.ts";
import { validateRuntimeAssetDescriptor, type RuntimeAsset } from "./contract.ts";

/**
 * Fetch a runtime asset
 *
 * Streams the bytes within the admitted size, checks the SHA-256, and gunzips a compressed asset within its original
 * size. Throws when the response fails or any check does not match.
 */
export async function fetchRuntimeAsset(
  asset: RuntimeAsset,
  signal: AbortSignal,
  progress?: (downloadedBytes: number, totalBytes: number) => void,
): Promise<Uint8Array> {
  validateRuntimeAssetDescriptor(asset);

  const response = await fetch(asset.url, { signal, credentials: "omit" });

  if (!response.ok || response.body === null) {
    await cancelBody(response.body);
    throw new Error(`Runtime asset could not load (${response.status})`);
  }

  const bytes = await readBoundedStream(
    response.body,
    asset.size,
    "Runtime asset exceeds its admitted size",
    (downloadedBytes) => progress?.(downloadedBytes, asset.size),
  );

  return decodeRuntimeAsset(asset, bytes);
}

/** Verify stored and decompressed bytes identically for HTTP and installed package assets. */
export async function decodeRuntimeAsset(asset: RuntimeAsset, bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.byteLength !== asset.size) {
    throw new Error("Runtime asset does not match its admitted size");
  }

  const hash = await sha256(bytes);

  if (hash !== asset.sha256) {
    throw new Error("Runtime asset integrity check failed");
  }

  if (asset.compression === "gzip") {
    const rawSize = asset.rawSize;

    if (rawSize === undefined) {
      throw new Error("Compressed runtime asset has no admitted original size");
    }

    const input = new Uint8Array(toArrayBuffer(bytes));
    const stream = createChunkedByteStream(input).pipeThrough(new DecompressionStream("gzip"));
    const raw = await readBoundedStream(stream, rawSize, "Decompressed runtime asset exceeds its admitted size");

    if (raw.byteLength !== rawSize || (await sha256(raw)) !== asset.rawSha256) {
      throw new Error("Runtime asset original-byte integrity check failed");
    }

    return raw;
  }

  return bytes;
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  sizeError: string,
  onProgress?: (bytesRead: number) => void,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const next = await reader.read();

      if (next.done) {
        break;
      }

      size += next.value.byteLength;

      if (size > maximumBytes) {
        throw new Error(sizeError);
      }

      chunks.push(next.value);
      onProgress?.(size);
    }
  } catch (cause) {
    try {
      await reader.cancel(cause);
    } catch {
      // Keep the original stream or callback failure.
    }

    throw cause;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) {
    return;
  }

  try {
    await body.cancel();
  } catch {
    // The HTTP failure remains the relevant error.
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)));

  return Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join("");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);

  return copy.buffer;
}
