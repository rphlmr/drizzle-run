import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { listSupportedTargets, resolveSupportedTuple } from "@drizzle-run/core/catalog";
import { listApprovedModules } from "@drizzle-run/core/registry";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeAsset } from "../assets/contract.ts";
import { createDeclarationArtifactLoader, createRemoteDeclarationArtifactSource } from "./declaration-source.ts";

const artifactId = "types:zod@4.4.3";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A gzip declaration artifact and its inventory entry, served by a stubbed `fetch` that counts requests. */
function makeServedArtifact({
  manifestArtifactId = artifactId,
  servedBytes,
}: { manifestArtifactId?: string; servedBytes?: Uint8Array<ArrayBuffer> } = {}) {
  const rawBytes = new TextEncoder().encode(
    JSON.stringify({
      artifactId: manifestArtifactId,
      files: [{ uri: "file:///__drizzle_run_types__/zod@4.4.3/index.d.ts", content: "export {};" }],
    }),
  );
  const storedBytes = new Uint8Array(gzipSync(rawBytes));
  const digest = sha256(rawBytes);
  const asset: RuntimeAsset = {
    url: `/runtime-assets/${digest}/types/zod__4.4.3.json.gz`,
    digest,
    sha256: sha256(storedBytes),
    size: storedBytes.length,
    compression: "gzip",
    rawSha256: digest,
    rawSize: rawBytes.length,
  };
  const fetchSpy = vi.fn(async () => new Response(servedBytes ?? storedBytes));
  vi.stubGlobal("fetch", fetchSpy);

  return { assets: { [artifactId]: asset }, fetchSpy };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRemoteDeclarationArtifactSource", () => {
  it("should fetch an artifact once and return its files", async () => {
    const { assets, fetchSpy } = makeServedArtifact();
    const source = createRemoteDeclarationArtifactSource({ assets });

    const [first, second] = await Promise.all([source.load(artifactId), source.load(artifactId)]);

    expect(first).toEqual([{ uri: "file:///__drizzle_run_types__/zod@4.4.3/index.d.ts", content: "export {};" }]);
    expect(second).toBe(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("should fail on bytes that do not match the inventory digest", async () => {
    const { assets } = makeServedArtifact({ servedBytes: new Uint8Array(gzipSync(new TextEncoder().encode("{}"))) });
    const source = createRemoteDeclarationArtifactSource({ assets });

    await expect(source.load(artifactId)).rejects.toThrow(/admitted size|integrity check failed/);
  });

  it("should retry an artifact whose load failed", async () => {
    const { assets, fetchSpy } = makeServedArtifact();
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const source = createRemoteDeclarationArtifactSource({ assets });

    await expect(source.load(artifactId)).rejects.toThrow("Runtime asset could not load (503)");
    await expect(source.load(artifactId)).resolves.toHaveLength(1);
  });

  it("should fail a fetch that stalls, even one that ignores its signal, and retry it on the next load", async () => {
    vi.useFakeTimers();

    try {
      const { assets } = makeServedArtifact();
      const signals: AbortSignal[] = [];
      const fetchAsset = vi.fn((_asset: RuntimeAsset, signal: AbortSignal) => {
        signals.push(signal);

        return new Promise<Uint8Array>(() => {});
      });
      const source = createRemoteDeclarationArtifactSource({ assets, fetchAsset, stallTimeoutMs: 1_000 });

      // Caught at once, so the rejection the timers cause is never unhandled.
      const failure = source.load(artifactId).catch((cause: unknown) => cause);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await failure).toBeInstanceOf(Error);
      expect(String(await failure)).toContain(`Declaration artifact ${artifactId}`);
      expect(signals[0]?.aborted).toBe(true);

      void source.load(artifactId).catch(() => undefined);
      expect(fetchAsset).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should keep a slow fetch going while bytes arrive", async () => {
    vi.useFakeTimers();

    try {
      const { assets } = makeServedArtifact();
      const served = await createRemoteDeclarationArtifactSource({ assets }).load(artifactId);
      const download = Promise.withResolvers<Uint8Array>();
      let reportProgress: ((downloadedBytes: number) => void) | undefined;
      const fetchAsset = vi.fn(
        (_asset: RuntimeAsset, _signal: AbortSignal, progress?: (downloadedBytes: number) => void) => {
          reportProgress = progress;

          return download.promise;
        },
      );
      const source = createRemoteDeclarationArtifactSource({ assets, fetchAsset, stallTimeoutMs: 1_000 });
      const load = source.load(artifactId);

      for (const downloadedBytes of [1, 2, 3]) {
        await vi.advanceTimersByTimeAsync(800);
        reportProgress?.(downloadedBytes);
      }

      download.resolve(new TextEncoder().encode(JSON.stringify({ artifactId, files: served })));

      await expect(load).resolves.toEqual(served);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should fail on an artifact the inventory does not list", async () => {
    const source = createRemoteDeclarationArtifactSource({ assets: {} });

    await expect(source.load(artifactId)).rejects.toThrow(
      "Declaration artifact types:zod@4.4.3 is not in the runtime asset inventory",
    );
  });

  it("should fail on another artifact's manifest", async () => {
    const { assets } = makeServedArtifact({ manifestArtifactId: "types:valibot@1.4.2" });
    const source = createRemoteDeclarationArtifactSource({ assets });

    await expect(source.load(artifactId)).rejects.toThrow("is not that artifact's manifest");
  });
});

describe("createDeclarationArtifactLoader", () => {
  it("should load a PostgreSQL ORM entry's driver artifact beside its own", async () => {
    const target = listSupportedTargets().find((candidate) => candidate.dialect === "postgresql");

    if (target === undefined) {
      throw new Error("Expected a PostgreSQL target");
    }

    const tuple = resolveSupportedTuple({ target, ormVersion: "0.45.4", kitVersion: "0.31.11" });
    const ormEntry = listApprovedModules({ tuple, guestFlavor: "slim" }).find(
      (entry) => entry.packageName === "drizzle-orm",
    );
    const load = vi.fn(async (id: string) => [{ uri: `file:///${id}.d.ts`, content: "" }]);
    const loadDeclarationArtifact = createDeclarationArtifactLoader({ load });

    if (ormEntry === undefined) {
      throw new Error("Expected the Legacy pair to approve drizzle-orm");
    }

    const files = await loadDeclarationArtifact(ormEntry, tuple);

    expect(files.map((file) => file.uri)).toEqual([
      "file:///types:drizzle-orm@0.45.4.d.ts",
      "file:///types:@types/pg@8.23.1+@types/node@24.19.2.d.ts",
    ]);
  });
});
