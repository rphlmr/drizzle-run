import type { RunDependencyPins, RunManifest, RunManifestIssue, RunManifestTarget } from "../manifest/types.ts";
import type { GuestFlavor } from "../registry/guest-images.ts";

/** The `kind` of a side-by-side manifest. */
export const PAIR_MANIFEST_KIND = "drizzle-run-pair";

/** The newest side-by-side manifest version this version reads. */
export const PAIR_MANIFEST_VERSION = 1;

/** A side's position: 0 shows first (left on a desktop), 1 second. */
export type PairSideIndex = 0 | 1;

/** Both side indexes, in display order. */
export const PAIR_SIDES: readonly PairSideIndex[] = [0, 1];

/** The longest side name, in characters. */
export const PAIR_SIDE_NAME_MAX_LENGTH = 40;

/** One side of a side-by-side project: its database, tested pair, an optional name and the files only it runs. */
export interface PairSide {
  /**
   * What the author calls this side; left out to go by the release. Plain text of 1 to
   * `PAIR_SIDE_NAME_MAX_LENGTH` characters, with no control characters and no space at either end.
   */
  name?: string;
  /** The side's database; the two sides may run different ones. */
  target: RunManifestTarget;
  dependencies: RunDependencyPins;
  /** The side's guest flavor; left out for `slim`. */
  guestFlavor?: GuestFlavor;
  /**
   * Files with a copy per side. Both sides list the same paths; a path is either here
   * (per side) or in the manifest's shared `files`, never both.
   */
  files: Record<string, string>;
}

/**
 * A project pinned to two release pairs, each on its own database. Every run runs both sides, each as the run
 * manifest `pairSide` builds: the shared files plus that side's own, on that side's database and pair.
 */
export interface PairManifest {
  kind: typeof PAIR_MANIFEST_KIND;
  manifestVersion: typeof PAIR_MANIFEST_VERSION;
  /** The same entrypoints on both sides. The seed entrypoint is always a shared file. */
  entrypoints: RunManifest["entrypoints"];
  /** Files both sides run: an edit on either side shows on both. */
  files: Record<string, string>;
  sides: readonly [PairSide, PairSide];
  env?: Record<string, string>;
  randomSeed?: number;
  /** Explicit shared drizzle-seed generator pin; omitted for defaults, or version 2 across release lines. */
  seedGeneratorVersion?: RunManifest["seedGeneratorVersion"];
}

/**
 * How a new side-by-side project starts: a copy of every file per side (the seed stays shared), or one set for
 * both.
 */
export type PairFilesStart = "separate" | "shared";

/**
 * What a side's files become when its pair changes: as they are, a copy of the other
 * side's per-side files, or shared with the other side.
 */
export type PairSideFiles = "keep" | "copy" | "share";

/** One problem found in a side-by-side manifest, at a path inside it. */
export interface PairManifestIssue {
  path: readonly (string | number)[];
  code: RunManifestIssue["code"] | "UNSUPPORTED_VERSION";
  message: string;
}

/** The result of `safeParsePairManifest`: the manifest, or every issue found. */
export type SafeParsePairManifestResult =
  | { success: true; data: PairManifest }
  | { success: false; issues: readonly PairManifestIssue[] };
