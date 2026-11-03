import type { RunManifest } from "@drizzle-run/core/manifest";
import { useState } from "react";

type Entrypoints = RunManifest["entrypoints"];

/** The seed file a project falls back to before it ever had one. */
export const DEFAULT_SEED_PATH = "seed.ts";

/** What the open file is to the file tabs and the seed switch. */
export interface FileRoles {
  /** Runs execute the seed first. */
  seedOn: boolean;
  /** The seed file exists, so its tab shows, on or off. */
  seedFileShown: boolean;
  /** The open file is the seed, on or off: it shows the seed switch. */
  seedSelected: boolean;
  /** The open file is a helper: not an entry and not the seed, so it can be renamed or deleted. */
  helperSelected: boolean;
}

/**
 * The open file's roles
 *
 * A seed that is off stays the seed file: its tab turns it back on, so it is never a helper to rename or delete.
 */
export function getFileRoles({
  entrypoints,
  seedPath,
  selected,
  hasFile,
}: {
  entrypoints: Entrypoints;
  seedPath: string;
  selected: string;
  hasFile: (path: string) => boolean;
}): FileRoles {
  const entrypointPaths = new Set(Object.values(entrypoints).filter((path) => path !== undefined));
  const seedFileShown = hasFile(seedPath);

  return {
    seedOn: entrypoints.seed !== undefined,
    seedFileShown,
    seedSelected: selected === seedPath && seedFileShown,
    helperSelected: !entrypointPaths.has(selected) && selected !== seedPath,
  };
}

/** The entrypoints after the seed switch flips, or why the seed cannot turn on. */
export type SeedToggle = { ok: true; entrypoints: Entrypoints } | { ok: false; error: string };

/**
 * Flip the seed switch
 *
 * On, the seed entry is dropped and its file kept. Off, `seedPath` becomes the seed again, when `canSeed` says the
 * project may seed from it.
 */
export function toggleSeedEntrypoint({
  entrypoints,
  seedPath,
  canSeed,
}: {
  entrypoints: Entrypoints;
  seedPath: string;
  canSeed: boolean;
}): SeedToggle {
  if (entrypoints.seed !== undefined) {
    const { seed: _seed, ...withoutSeed } = entrypoints;

    return { ok: true, entrypoints: withoutSeed };
  }

  if (!canSeed) {
    return { ok: false, error: `Add ${seedPath} before enabling seed execution.` };
  }

  return { ok: true, entrypoints: { ...entrypoints, seed: seedPath } };
}

/** Options of `useSeedSwitch`. */
export interface UseSeedSwitchOptions {
  entrypoints: Entrypoints;
  /** Whether runs may seed from the file: it exists, and in a side-by-side project both sides share it. */
  canSeed: (path: string) => boolean;
  /** Saves the project with the flipped entrypoints. */
  onChange: (entrypoints: Entrypoints) => void;
  reportError: (error: string) => void;
}

/**
 * The seed switch of a project view
 *
 * Keeps the last seed path while seeding is off, so the seed tab turns the same file back on.
 */
export function useSeedSwitch({ entrypoints, canSeed, onChange, reportError }: UseSeedSwitchOptions) {
  const [lastSeedPath, setLastSeedPath] = useState(entrypoints.seed ?? DEFAULT_SEED_PATH);
  const seedPath = entrypoints.seed ?? lastSeedPath;

  if (seedPath !== lastSeedPath) {
    setLastSeedPath(seedPath);
  }

  const toggleSeed = () => {
    const toggle = toggleSeedEntrypoint({ entrypoints, seedPath, canSeed: canSeed(seedPath) });

    if (toggle.ok) {
      onChange(toggle.entrypoints);
    } else {
      reportError(toggle.error);
    }
  };

  return { seedPath, toggleSeed };
}
