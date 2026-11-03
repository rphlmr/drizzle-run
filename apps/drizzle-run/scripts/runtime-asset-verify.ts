import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { RuntimeAsset } from "../worker/runtime-assets.generated.ts";

interface VerificationOptions {
  origin: string;
  assets: readonly RuntimeAsset[];
  fetchAsset: (url: URL) => Promise<Response>;
  propagationTimeoutMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  wait?: (delayMs: number) => Promise<unknown>;
  log: (line: string) => void;
}

/**
 * The Content-Digest the Worker sends for an asset: its SHA-256 in base64, as RFC 9530 writes it.
 */
function getExpectedContentDigest(asset: RuntimeAsset) {
  return `sha-256=:${Buffer.from(asset.sha256, "hex").toString("base64")}:`;
}

/**
 * Fetches one asset through the Worker, and returns null when it is served intact, or why it failed:
 * `propagating` (no 200 yet, or no response) may pass once the new deployment is live; `corrupt` (a 200 with the
 * wrong digest or bytes) will not.
 */
async function checkServedAsset({
  origin,
  asset,
  fetchAsset,
}: {
  origin: string;
  asset: RuntimeAsset;
  fetchAsset: VerificationOptions["fetchAsset"];
}) {
  const url = new URL(`/runtime-assets/${asset.key}`, origin);
  let response;

  try {
    response = await fetchAsset(url);
  } catch (cause) {
    return {
      kind: "propagating",
      message: `${url} failed to respond: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  if (response.status !== 200) {
    await response.body?.cancel();

    return { kind: "propagating", message: `${url} answered ${response.status}, expected 200` };
  }

  const contentDigest = response.headers.get("content-digest");
  const expectedDigest = getExpectedContentDigest(asset);

  if (contentDigest !== expectedDigest) {
    await response.body?.cancel();

    return { kind: "corrupt", message: `${url} sent Content-Digest ${contentDigest}, expected ${expectedDigest}` };
  }

  const bytes = Buffer.from(await response.arrayBuffer());

  if (bytes.length !== asset.size || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
    return { kind: "corrupt", message: `${url} sent ${bytes.length} bytes that do not match the inventory's SHA-256` };
  }

  return null;
}

/**
 * Verify a deployment's runtime assets
 *
 * Fetches every inventory asset through the deployed Worker and requires 200, the inventory's Content-Digest, and the
 * same bytes. That proves the new Worker is live, reads the bucket the upload wrote, and serves this inventory.
 *
 * While the deployment propagates, the previous Worker may still answer: it serves the assets both inventories share,
 * and answers 404 for the new ones. So any asset without a 200 is retried every `retryDelayMs` until one deadline,
 * shared by the whole verification, passes. A 200 with the wrong digest or bytes is not propagation and fails at once.
 *
 * @param options.origin - The deployed Worker's origin, such as `https://run.example.com`
 * @param options.assets - The deployed inventory
 * @param options.fetchAsset - `fetch`, injected for tests
 * @param options.propagationTimeoutMs - How long, from the start, an asset may keep failing to answer 200
 * @param options.retryDelayMs - The wait between two tries of one asset
 * @param options.now - The clock, injected for tests
 * @param options.wait - Waits a number of milliseconds, injected for tests
 * @param options.log - Receives one line per checked asset and per retry
 */
export async function verifyDeployedRuntimeAssets({
  origin,
  assets,
  fetchAsset,
  propagationTimeoutMs = 30_000,
  retryDelayMs = 5_000,
  now = Date.now,
  wait = delay,
  log,
}: VerificationOptions) {
  if (assets.length === 0) {
    throw new Error("Cannot verify a deployment with an empty runtime asset inventory");
  }

  const deadline = now() + propagationTimeoutMs;

  for (const asset of assets) {
    let failure = await checkServedAsset({ origin, asset, fetchAsset });

    while (failure?.kind === "propagating" && now() < deadline) {
      log(`${failure.message}; retrying in ${retryDelayMs} ms while the deployment propagates`);
      await wait(retryDelayMs);
      failure = await checkServedAsset({ origin, asset, fetchAsset });
    }

    if (failure !== null) {
      throw new Error(`Deployment verification failed: ${failure.message}`);
    }

    log(`Verified ${asset.name}`);
  }
}
