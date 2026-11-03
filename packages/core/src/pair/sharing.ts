import { releaseLineOf } from "../registry/selectors.ts";
import { PAIR_SEED_PATH } from "./schema.ts";
import { isCrossDatabasePair } from "./targets.ts";
import type { PairManifest } from "./types.ts";

/**
 * True when one side runs Legacy (0.x) and the other Next (1.x)
 *
 * Such a pair shares only the seed: the lines differ in imports and APIs, so every other file has a copy per side.
 */
export function isCrossLinePair(manifest: Pick<PairManifest, "sides">): boolean {
  const [first, second] = manifest.sides;

  return releaseLineOf(first.dependencies["drizzle-orm"]) !== releaseLineOf(second.dependencies["drizzle-orm"]);
}

/**
 * True when both sides could run one copy of the file at `path`
 *
 * The seed always can. A pair across release lines shares nothing else, and sides on two databases never share the
 * schema entrypoint; any other file can be shared.
 */
export function canSharePairFile(manifest: Pick<PairManifest, "entrypoints" | "sides">, path: string): boolean {
  if (path === PAIR_SEED_PATH) {
    return true;
  }

  if (isCrossLinePair(manifest)) {
    return false;
  }

  return !isCrossDatabasePair(manifest) || path !== manifest.entrypoints.schema;
}
