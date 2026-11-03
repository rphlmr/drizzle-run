import { isPlainObject } from "es-toolkit";
import { describe, expect, it } from "vitest";

import type { R2Bucket } from "./platform";
import { serveRuntimeAsset } from "./runtime-assets";

const digest = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";
// The MD5 of the four stored bytes, 1 2 3 4.
const md5 = "08d6c05a21512a79a1dfeb9d2a8f262f";
const inventory = Object.freeze({
  [`${digest}/quickjs.wec`]: {
    objectKey: `${digest}/quickjs.wec`,
    contentType: "application/octet-stream",
    sha256: digest,
    md5,
    size: 4,
  },
});

function makeStoredObject(checksumMd5 = md5, size = 4): { body: ReadableStream<Uint8Array>; bucket: R2Bucket } {
  const checksum = new ArrayBuffer(16);
  new Uint8Array(checksum).set(Uint8Array.from(checksumMd5.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16)));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      controller.close();
    },
  });

  return {
    body,
    bucket: {
      async get() {
        return {
          body,
          httpEtag: '"r2-version"',
          size,
          checksums: { md5: checksum },
        };
      },
    },
  };
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();

  if (!isRecord(value)) {
    throw new TypeError("Expected a JSON object response.");
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

describe("runtime asset delivery", () => {
  it("should stream only inventory-approved R2 bytes with immutable integrity headers", async () => {
    const stored = makeStoredObject();
    const response = await serveRuntimeAsset(
      new Request(`https://run.test/runtime-assets/${digest}/quickjs.wec`),
      stored.bucket,
      `/runtime-assets/${digest}/quickjs.wec`,
      inventory,
    );
    expect(response.status).toBe(200);
    expect(response.body).toBe(stored.body);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-digest")).toMatch(/^sha-256=:/);
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(response.headers.get("etag")).toBe('"r2-version"');
  });

  it("should not fetch unknown assets, and reject stored content with the wrong R2 checksum", async () => {
    let reads = 0;
    const stored = makeStoredObject("b".repeat(32));
    const bucket: R2Bucket = {
      async get(key) {
        reads += 1;
        return stored.bucket.get(key);
      },
    };
    const unknownDigest = "b".repeat(64);
    const unknown = await serveRuntimeAsset(
      new Request(`https://run.test/runtime-assets/${unknownDigest}/quickjs.wec`),
      bucket,
      `/runtime-assets/${unknownDigest}/quickjs.wec`,
      inventory,
    );
    const mismatch = await serveRuntimeAsset(
      new Request(`https://run.test/runtime-assets/${digest}/quickjs.wec`),
      bucket,
      `/runtime-assets/${digest}/quickjs.wec`,
      inventory,
    );
    expect(unknown.status).toBe(404);
    expect(mismatch.status).toBe(502);
    expect((await readJsonObject(mismatch)).error).toMatchObject({ code: "asset_integrity_mismatch" });
    expect(reads).toBe(1);
  });

  it("should reject a stored object of the wrong size even when its checksum matches", async () => {
    const stored = makeStoredObject(md5, 5);
    const response = await serveRuntimeAsset(
      new Request(`https://run.test/runtime-assets/${digest}/quickjs.wec`),
      stored.bucket,
      `/runtime-assets/${digest}/quickjs.wec`,
      inventory,
    );
    expect(response.status).toBe(502);
    expect((await readJsonObject(response)).error).toMatchObject({ code: "asset_integrity_mismatch" });
  });

  it("should support HEAD and immutable conditional reads", async () => {
    const stored = makeStoredObject();
    const url = `https://run.test/runtime-assets/${digest}/quickjs.wec`;
    const head = await serveRuntimeAsset(
      new Request(url, { method: "HEAD" }),
      stored.bucket,
      `/runtime-assets/${digest}/quickjs.wec`,
      inventory,
    );
    const notModified = await serveRuntimeAsset(
      new Request(url, { headers: { "if-none-match": '"r2-version"' } }),
      stored.bucket,
      `/runtime-assets/${digest}/quickjs.wec`,
      inventory,
    );
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(notModified.status).toBe(304);
  });

  it("should return a typed failure when R2 is unavailable", async () => {
    const bucket: R2Bucket = {
      async get() {
        throw new Error("R2 details must not be returned");
      },
    };
    const response = await serveRuntimeAsset(
      new Request(`https://run.test/runtime-assets/${digest}/quickjs.wec`),
      bucket,
      `/runtime-assets/${digest}/quickjs.wec`,
      inventory,
    );
    expect(response.status).toBe(503);
    expect(JSON.stringify(await readJsonObject(response))).not.toContain("R2 details");
  });
});
