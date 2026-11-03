import type { RunManifest } from "@drizzle-run/core/manifest";
import { PAIR_SEED_PATH } from "@drizzle-run/core/pair";

/**
 * Why a project cannot become side by side because of its seed, or `null` when it can
 *
 * A side-by-side project seeds from `seed.ts` only. Core refuses a seed under another name rather than moving it, since
 * moving it would change what its relative imports point at. This says the same before the user picks anything, in
 * core's wording.
 */
export function resolveRenamedSeedRefusal(entrypoints: RunManifest["entrypoints"]): string | null {
  const { seed } = entrypoints;

  if (seed === undefined || seed === PAIR_SEED_PATH) {
    return null;
  }

  return `A side-by-side project seeds from ${PAIR_SEED_PATH}: rename ${seed} to ${PAIR_SEED_PATH} first.`;
}
