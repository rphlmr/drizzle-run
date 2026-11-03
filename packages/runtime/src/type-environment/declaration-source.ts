import * as z from "zod/mini";

import { declarationArtifactAssets } from "../assets/configuration.generated.ts";
import type { RuntimeAsset } from "../assets/contract.ts";
import { fetchRuntimeAsset } from "../assets/service.ts";
import type { DeclarationArtifactFile, DeclarationArtifactLoader } from "./types.ts";

/** Where the declaration artifacts of approved modules come from */
export interface DeclarationArtifactSource {
  /**
   * Load one artifact's declaration files by its id, such as `types:zod@4.4.3`
   *
   * Throws when the artifact is unknown, fails to load, or fails its integrity check.
   */
  load(artifactId: string): Promise<readonly DeclarationArtifactFile[]>;
}

/** Dependencies of `createRemoteDeclarationArtifactSource` */
export interface RemoteDeclarationArtifactSourceDependencies {
  /** The artifacts by id; defaults to the generated runtime asset inventory. */
  assets?: Readonly<Record<string, RuntimeAsset>>;
  /** Fetches and checks one asset, calling `progress` as bytes arrive; defaults to `fetchRuntimeAsset`. */
  fetchAsset?: (
    asset: RuntimeAsset,
    signal: AbortSignal,
    progress?: (downloadedBytes: number) => void,
  ) => Promise<Uint8Array>;
  /** How long a fetch may go without new bytes before it fails; `DECLARATION_FETCH_STALL_MS` by default. */
  stallTimeoutMs?: number;
}

/** How long a declaration fetch may go without new bytes before it fails, so a hung request never blocks the rest. */
const DECLARATION_FETCH_STALL_MS = 30_000;

const DeclarationArtifactManifestSchema = z.object({
  artifactId: z.string(),
  files: z.array(z.object({ uri: z.string(), content: z.string() })),
});

/**
 * Create a declaration artifact source over the runtime assets
 *
 * Fetches each artifact from its content-addressed `/runtime-assets/<sha256>/types/<name>.json.gz` address, checks the
 * size and SHA-256 of the stored and the decompressed bytes, and parses it. A failed check is an error, never a
 * fallback. Each artifact is fetched once per source; a failed load is retried on the next call. A fetch that goes
 * `stallTimeoutMs` without new bytes is aborted and fails, however long the whole download takes. The timeout is the
 * source's, not a caller's signal, since every editor of the page shares one load per artifact.
 */
export function createRemoteDeclarationArtifactSource({
  assets = declarationArtifactAssets,
  fetchAsset = fetchRuntimeAsset,
  stallTimeoutMs = DECLARATION_FETCH_STALL_MS,
}: RemoteDeclarationArtifactSourceDependencies = {}): DeclarationArtifactSource {
  const loadsByArtifactId = new Map<string, Promise<readonly DeclarationArtifactFile[]>>();

  /** Fetch an asset, failing once it goes `stallTimeoutMs` without new bytes, even if the fetch ignores its signal. */
  async function fetchWithStallTimeout(artifactId: string, asset: RuntimeAsset): Promise<Uint8Array> {
    const controller = new AbortController();
    const abortOnStall = () =>
      setTimeout(
        () =>
          controller.abort(
            new Error(`Declaration artifact ${artifactId} at ${asset.url} stalled for ${stallTimeoutMs} ms`),
          ),
        stallTimeoutMs,
      );
    let timer = abortOnStall();
    const stalled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });

    try {
      return await Promise.race([
        fetchAsset(asset, controller.signal, () => {
          clearTimeout(timer);
          timer = abortOnStall();
        }),
        stalled,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchArtifact(artifactId: string): Promise<readonly DeclarationArtifactFile[]> {
    const asset = Object.hasOwn(assets, artifactId) ? assets[artifactId] : undefined;

    if (asset === undefined) {
      throw new Error(`Declaration artifact ${artifactId} is not in the runtime asset inventory`);
    }

    const bytes = await fetchWithStallTimeout(artifactId, asset);
    const manifest = DeclarationArtifactManifestSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));

    if (!manifest.success || manifest.data.artifactId !== artifactId) {
      throw new Error(`Declaration artifact ${artifactId} at ${asset.url} is not that artifact's manifest`);
    }

    return Object.freeze(manifest.data.files);
  }

  return {
    load(artifactId) {
      const pending = loadsByArtifactId.get(artifactId);

      if (pending !== undefined) {
        return pending;
      }

      const load = fetchArtifact(artifactId);
      loadsByArtifactId.set(artifactId, load);
      load.catch(() => loadsByArtifactId.delete(artifactId));

      return load;
    },
  };
}

/**
 * Create a loader of an approved module's declarations from a source
 *
 * A PostgreSQL `drizzle-orm` entry also gets its guest's driver declarations, shared by every guest that pins the
 * same `@types/pg` and `@types/node`.
 */
export function createDeclarationArtifactLoader(source: DeclarationArtifactSource): DeclarationArtifactLoader {
  return async (entry) => {
    const driverArtifact = entry.types.driverArtifact;
    const [files, driverFiles] = await Promise.all([
      source.load(entry.types.closureArtifact.id),
      driverArtifact === undefined ? [] : source.load(driverArtifact.id),
    ]);

    return [...files, ...driverFiles];
  };
}

/** Load an approved module's declarations from the runtime assets, shared by every editor of the page. */
export const loadRuntimeAssetDeclarationArtifact: DeclarationArtifactLoader = createDeclarationArtifactLoader(
  createRemoteDeclarationArtifactSource(),
);
