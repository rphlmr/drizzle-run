import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import type { RuntimeAsset } from "../worker/runtime-assets.generated.ts";
import { verifyDeployedRuntimeAssets } from "./runtime-asset-verify.ts";

const origin = "https://run.example.com";

function makeAsset({ name, content }: { name: string; content: string }): RuntimeAsset {
  const sha256 = createHash("sha256").update(content).digest("hex");

  return {
    digest: sha256,
    name,
    key: `${sha256}/${name}`,
    contentType: "application/gzip",
    sha256,
    md5: createHash("md5").update(content).digest("hex"),
    size: Buffer.byteLength(content),
  };
}

const engine = makeAsset({ name: "engines/quickjs.tar.gz", content: "engine" });

/**
 * A gzip editor types artifact as the inventory lists it: the key's digest is the raw JSON's SHA-256, while `sha256`,
 * `md5` and `size` describe the stored gzip bytes the Worker serves.
 */
function makeTypesAsset({ stem, json }: { stem: string; json: string }) {
  const stored = gzipSync(json);
  const rawSha256 = createHash("sha256").update(json).digest("hex");
  const name = `types/${stem}.json.gz`;
  const asset: RuntimeAsset = {
    digest: rawSha256,
    name,
    key: `${rawSha256}/${name}`,
    contentType: "application/gzip",
    sha256: createHash("sha256").update(stored).digest("hex"),
    md5: createHash("md5").update(stored).digest("hex"),
    size: stored.length,
    compression: "gzip",
    rawSha256,
    rawSize: Buffer.byteLength(json),
  };

  return { asset, stored };
}
const guest = makeAsset({ name: "guests/orm-1.0.0-rc.5__kit-1.0.0-rc.5+effect.tar.gz", content: "guest" });
const contents = new Map([
  [engine.key, "engine"],
  [guest.key, "guest"],
]);

/**
 * A Worker that serves each asset as the real one does, unless `answer` overrides the response for a key.
 */
function makeFetch(answer: (key: string) => Response | undefined = () => undefined) {
  return vi.fn(async (url: URL) => {
    const key = url.pathname.replace("/runtime-assets/", "");
    const content = contents.get(key) ?? "";
    const sha256 = createHash("sha256").update(content).digest("base64");

    return (
      answer(key) ??
      new Response(content, {
        status: contents.has(key) ? 200 : 404,
        headers: { "Content-Digest": `sha-256=:${sha256}:` },
      })
    );
  });
}

/**
 * Verifies the two assets with a fake clock that `wait` advances, so retries take no real time.
 */
function verify(fetchAsset: ReturnType<typeof makeFetch>) {
  let clockMs = 0;
  const wait = vi.fn(async (delayMs: number) => {
    clockMs += delayMs;
  });
  const verification = verifyDeployedRuntimeAssets({
    origin,
    assets: [engine, guest],
    fetchAsset,
    propagationTimeoutMs: 30_000,
    retryDelayMs: 5_000,
    now: () => clockMs,
    wait,
    log: () => {},
  });

  return { verification, wait };
}

/**
 * Counts requests per asset key.
 */
function countRequests(fetchAsset: ReturnType<typeof makeFetch>, key: string) {
  return fetchAsset.mock.calls.filter(([url]) => url.pathname.endsWith(key)).length;
}

describe("verifyDeployedRuntimeAssets", () => {
  it("should accept a Worker that serves every asset intact", async () => {
    const fetchAsset = makeFetch();
    const { verification, wait } = verify(fetchAsset);

    await verification;

    expect(fetchAsset.mock.calls.map(([url]) => url.href)).toEqual([
      `${origin}/runtime-assets/${engine.key}`,
      `${origin}/runtime-assets/${guest.key}`,
    ]);
    expect(wait).not.toHaveBeenCalled();
  });

  it("should check a gzip types artifact against its stored bytes, not its raw digest", async () => {
    const { asset: types, stored } = makeTypesAsset({ stem: "drizzle-orm__1.0.0-rc.5", json: '{"files":{}}' });
    const fetchAsset = vi.fn(
      async (_url: URL) =>
        new Response(stored, {
          headers: { "Content-Digest": `sha-256=:${createHash("sha256").update(stored).digest("base64")}:` },
        }),
    );

    await verifyDeployedRuntimeAssets({ origin, assets: [types], fetchAsset, log: () => {} });

    expect(types.digest).not.toBe(types.sha256);
    expect(fetchAsset).toHaveBeenCalledWith(new URL(`/runtime-assets/${types.key}`, origin));
  });

  it("should retry an asset only the new deployment has until the new Worker serves it", async () => {
    let guestRequests = 0;
    const fetchAsset = makeFetch((key) => {
      if (key !== guest.key) {
        return undefined;
      }

      guestRequests += 1;

      return guestRequests <= 2 ? new Response(null, { status: 404 }) : undefined;
    });
    const { verification, wait } = verify(fetchAsset);

    await verification;

    expect(countRequests(fetchAsset, guest.key)).toBe(3);
    expect(countRequests(fetchAsset, engine.key)).toBe(1);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("should fail with the last answer when an asset is still missing at the deadline", async () => {
    const fetchAsset = makeFetch((key) => (key === guest.key ? new Response(null, { status: 404 }) : undefined));
    const { verification, wait } = verify(fetchAsset);

    await expect(verification).rejects.toThrow(`/runtime-assets/${guest.key} answered 404, expected 200`);
    // 30 s of 5 s waits.
    expect(wait).toHaveBeenCalledTimes(6);
  });

  it("should retry an asset whose request fails to get a response", async () => {
    let engineRequests = 0;
    const servingFetch = makeFetch();
    const fetchAsset = vi.fn(async (url: URL) => {
      if (url.pathname.endsWith(engine.key) && engineRequests === 0) {
        engineRequests += 1;
        throw new Error("connection reset");
      }

      return servingFetch(url);
    });
    const { verification, wait } = verify(fetchAsset);

    await verification;

    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("should fail at once on a Content-Digest that is not the inventory's", async () => {
    const fetchAsset = makeFetch((key) =>
      key === engine.key ? new Response("engine", { headers: { "Content-Digest": "sha-256=:AAAA:" } }) : undefined,
    );
    const { verification, wait } = verify(fetchAsset);

    await expect(verification).rejects.toThrow("sent Content-Digest sha-256=:AAAA:");
    expect(wait).not.toHaveBeenCalled();
    expect(countRequests(fetchAsset, engine.key)).toBe(1);
  });

  it("should fail at once on bytes that do not match the inventory", async () => {
    const engineDigest = createHash("sha256").update("engine").digest("base64");
    const fetchAsset = makeFetch((key) =>
      key === engine.key
        ? new Response("tampered", { headers: { "Content-Digest": `sha-256=:${engineDigest}:` } })
        : undefined,
    );
    const { verification, wait } = verify(fetchAsset);

    await expect(verification).rejects.toThrow("bytes that do not match the inventory's SHA-256");
    expect(wait).not.toHaveBeenCalled();
  });
});
