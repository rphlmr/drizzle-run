import type { RunManifest, RunManifestTarget } from "../manifest/types.ts";
import { PAIR_MANIFEST_KIND, type PairManifest } from "./types.ts";

/**
 * List the databases a manifest runs, one per side
 *
 * A one-version manifest runs one; a side-by-side manifest one per side, in side order, repeats kept. Code that reads
 * a project's databases goes through here rather than `manifest.target`, so every kind of manifest, a future one
 * included, answers the same way.
 */
export function listManifestTargets(
  manifest: RunManifest | PairManifest,
): readonly [RunManifestTarget] | readonly [RunManifestTarget, RunManifestTarget] {
  if (manifest.kind === PAIR_MANIFEST_KIND) {
    return [manifest.sides[0].target, manifest.sides[1].target];
  }

  return [manifest.target];
}

/** List the databases a manifest runs, in side order and without repeats: one, or two for sides on both. */
export function listManifestDialects(manifest: RunManifest | PairManifest): RunManifestTarget["dialect"][] {
  return [...new Set(listManifestTargets(manifest).map((target) => target.dialect))];
}

/**
 * True when the two sides run different databases
 *
 * Such a pair gives each side its own schema entrypoint, since PostgreSQL and SQLite build tables with different
 * modules; every other file may still be shared.
 */
export function isCrossDatabasePair(manifest: Pick<PairManifest, "sides">): boolean {
  return manifest.sides[0].target.dialect !== manifest.sides[1].target.dialect;
}
