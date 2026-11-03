import type { DatabaseTarget } from "@drizzle-run/core/catalog";
import { createPairManifest, type PairManifest } from "@drizzle-run/core/pair";

import { fixtureTuple, projectManifest } from "./run";

/** What `pairManifest` varies besides its targets. */
export interface PairManifestOptions {
  /** Gives the project both sides start from a `seed.ts`, which the pair keeps shared. Defaults to none. */
  seed?: boolean;
}

/**
 * A side-by-side project: the Legacy pair on the first target, the Next pair on the second
 *
 * Both sides start from `projectManifest` with separate files, except the seed, which a pair always shares. Both
 * targets default to PostgreSQL; two different dialects make a cross-database pair. Throws when the catalog ships no
 * pair of that line for a target.
 */
export function pairManifest(
  targets: readonly [DatabaseTarget, DatabaseTarget] = [{ dialect: "postgresql" }, { dialect: "postgresql" }],
  { seed = false }: PairManifestOptions = {},
): PairManifest {
  const [legacyTarget, nextTarget] = targets;

  return createPairManifest(
    projectManifest(legacyTarget.dialect, { seed }),
    [fixtureTuple(legacyTarget, "legacy"), fixtureTuple(nextTarget, "next")],
    "separate",
  );
}
