import { omit, pick } from "es-toolkit";

import { assertImportsAvailable } from "../manifest/imports.ts";
import { pinManifestToPair } from "../manifest/retired-pair.ts";
import type { RunManifest } from "../manifest/types.ts";
import { parseRunManifest } from "../manifest/validation.ts";
import { RUNTIME_CONTEXT_SPECIFIER } from "../registry/context-specifiers.ts";
import { resolveGuestFlavor, type GuestFlavor } from "../registry/guest-images.ts";
import { resolveSupportedTuple } from "../registry/selectors.ts";
import type { SupportedRuntimeTuple } from "../registry/types.ts";
import { PAIR_SEED_PATH, toRenamedSeedMessage } from "./schema.ts";
import { isCrossLinePair } from "./sharing.ts";
import {
  pairSideLabels,
  throwWithSideLabel,
  toPairSideLabels,
  toPairSideLabelSource,
  type PairSideLabelSource,
} from "./side-label.ts";
import { isCrossDatabasePair } from "./targets.ts";
import {
  PAIR_MANIFEST_KIND,
  PAIR_MANIFEST_VERSION,
  PAIR_SIDES,
  type PairFilesStart,
  type PairManifest,
  type PairSide,
  type PairSideFiles,
  type PairSideIndex,
} from "./types.ts";
import { parsePairManifest } from "./validation.ts";

/** Get the side opposite `side`. */
export function otherSide(side: PairSideIndex): PairSideIndex {
  return side === 0 ? 1 : 0;
}

/**
 * The drizzle-seed generator version both sides seed with, when they are on different release lines
 *
 * Legacy and Next drizzle-seed default to different generator versions, so the same `seed` number fills each side with
 * other rows. Version 2 is the newest both accept. Two Next sides keep their default, which they share.
 */
const CROSS_LINE_SEED_GENERATOR_VERSION = "2";

/**
 * Get the run manifest one side runs: the shared files plus its own, on its own pair
 *
 * A side by side across Legacy and Next pins `seedGeneratorVersion`, so a drizzle-seed `seed()` that names no version
 * seeds the same rows on both sides.
 */
export function pairSide(manifest: PairManifest, side: PairSideIndex): RunManifest {
  const isCrossLine = isCrossLinePair(manifest);

  return {
    kind: "drizzle-run",
    manifestVersion: 1,
    target: manifest.sides[side].target,
    dependencies: manifest.sides[side].dependencies,
    ...(manifest.sides[side].guestFlavor === undefined ? {} : { guestFlavor: manifest.sides[side].guestFlavor }),
    files: { ...manifest.files, ...manifest.sides[side].files },
    entrypoints: manifest.entrypoints,
    ...(manifest.env === undefined ? {} : { env: manifest.env }),
    ...(manifest.randomSeed === undefined ? {} : { randomSeed: manifest.randomSeed }),
    ...(manifest.seedGeneratorVersion !== undefined
      ? { seedGeneratorVersion: manifest.seedGeneratorVersion }
      : isCrossLine
        ? { seedGeneratorVersion: CROSS_LINE_SEED_GENERATOR_VERSION }
        : {}),
  };
}

/**
 * Get the supported pair a side runs on
 *
 * Throws when the side's pair is not supported, which a parsed manifest rules out.
 */
export function pairSideTuple(manifest: PairManifest, side: PairSideIndex): SupportedRuntimeTuple {
  return resolveSupportedTuple({
    target: manifest.sides[side].target,
    ormVersion: manifest.sides[side].dependencies["drizzle-orm"],
    kitVersion: manifest.sides[side].dependencies["drizzle-kit"],
  });
}

/** Give each side its own copy of the shared files at `paths`; a path that is not shared is left as it is. */
function splitSharedFiles(manifest: PairManifest, paths: readonly string[]): PairManifest {
  const split = pick(manifest.files, [...paths]);
  const [firstSide, secondSide] = manifest.sides;

  return {
    ...manifest,
    files: omit(manifest.files, [...paths]),
    sides: [
      { ...firstSide, files: { ...split, ...firstSide.files } },
      { ...secondSide, files: { ...split, ...secondSide.files } },
    ],
  };
}

/**
 * Give each side its own copy of every shared file the pair cannot share
 *
 * A pair across release lines shares only the seed; sides on two databases each keep their own schema entrypoint.
 */
function splitUnshareableFiles(manifest: PairManifest): PairManifest {
  if (isCrossLinePair(manifest)) {
    return splitSharedFiles(
      manifest,
      Object.keys(manifest.files).filter((path) => path !== PAIR_SEED_PATH),
    );
  }

  return isCrossDatabasePair(manifest) ? splitSharedFiles(manifest, [manifest.entrypoints.schema]) : manifest;
}

/** True when both sides run one copy of the file. */
export function isSharedPairFile(manifest: PairManifest, path: string): boolean {
  return Object.hasOwn(manifest.files, path);
}

const CONTROL_CHARACTERS_PATTERN = /\p{Cc}/gu;
const WHITESPACE_RUN_PATTERN = /\s+/gu;

/**
 * Name a side, or clear its name
 *
 * Control characters and runs of spaces become one space and both ends are trimmed; an empty name clears it, so the
 * side goes by its release again. Throws `PairManifestValidationError` for a name longer than 40 characters.
 */
export function renamePairSide(manifest: PairManifest, side: PairSideIndex, name: string): PairManifest {
  const cleanName = name.replace(CONTROL_CHARACTERS_PATTERN, " ").replace(WHITESPACE_RUN_PATTERN, " ").trim();
  const unnamedSide = omit(manifest.sides[side], ["name"]);

  return parsePairManifest(
    replaceSide(manifest, side, cleanName === "" ? unnamedSide : { ...unnamedSide, name: cleanName }),
  );
}

function replaceSides(manifest: PairManifest, sides: readonly [PairSide, PairSide]): PairManifest {
  return { ...manifest, sides };
}

function replaceSide(manifest: PairManifest, side: PairSideIndex, nextSide: PairSide): PairManifest {
  return replaceSides(manifest, side === 0 ? [nextSide, manifest.sides[1]] : [manifest.sides[0], nextSide]);
}

/**
 * Write a file from one side
 *
 * A shared file changes on both sides, a per-side file on this side only. Throws when `path` is in neither.
 */
export function editPairFile(
  manifest: PairManifest,
  side: PairSideIndex,
  path: string,
  contents: string,
): PairManifest {
  if (isSharedPairFile(manifest, path)) {
    return { ...manifest, files: { ...manifest.files, [path]: contents } };
  }

  const currentSide = manifest.sides[side];

  if (!Object.hasOwn(currentSide.files, path)) {
    throw new Error(`${path} is not in this project`);
  }

  return replaceSide(manifest, side, { ...currentSide, files: { ...currentSide.files, [path]: contents } });
}

/**
 * Split a shared file into one copy per side
 *
 * Each copy starts from the shared contents. Throws when `path` is not shared or is the seed file, on or off.
 */
export function splitPairFile(manifest: PairManifest, path: string): PairManifest {
  const contents = manifest.files[path];

  if (contents === undefined || !isSharedPairFile(manifest, path)) {
    throw new Error(`${path} is not a shared file`);
  }

  if (path === PAIR_SEED_PATH) {
    throw new Error(`${path} is the seed file both sides share, on or off, so it stays shared`);
  }

  const [firstSide, secondSide] = manifest.sides;

  return {
    ...manifest,
    files: omit(manifest.files, [path]),
    sides: [
      { ...firstSide, files: { ...firstSide.files, [path]: contents } },
      { ...secondSide, files: { ...secondSide.files, [path]: contents } },
    ],
  };
}

/**
 * Add a file to a side-by-side project
 *
 * The file is shared, or gets the same copy on each side when the pair is across release lines, which shares only
 * the seed: `seed.ts` is always shared, so the seed switch can turn it on. Throws when the project already has
 * `path`, which rules out the schema entrypoint.
 */
export function addPairFile(manifest: PairManifest, path: string, contents: string): PairManifest {
  if (Object.hasOwn(manifest.files, path) || Object.hasOwn(manifest.sides[0].files, path)) {
    throw new Error(`${path} is already in this project`);
  }

  if (!isCrossLinePair(manifest) || path === PAIR_SEED_PATH) {
    return { ...manifest, files: { ...manifest.files, [path]: contents } };
  }

  const [firstSide, secondSide] = manifest.sides;

  return {
    ...manifest,
    sides: [
      { ...firstSide, files: { ...firstSide.files, [path]: contents } },
      { ...secondSide, files: { ...secondSide.files, [path]: contents } },
    ],
  };
}

/**
 * Share a per-side file
 *
 * Makes a per-side file one shared file, keeping the copy from `from`. Throws when `path` has no copy on that side,
 * and a `PairManifestValidationError` on a pair across release lines, which shares only the seed, and for the schema
 * entrypoint of sides on two databases.
 */
export function sharePairFile(manifest: PairManifest, path: string, from: PairSideIndex): PairManifest {
  const contents = manifest.sides[from].files[path];

  if (contents === undefined) {
    throw new Error(`${path} has no copy per side`);
  }

  const [firstSide, secondSide] = manifest.sides;

  return parsePairManifest({
    ...manifest,
    files: { ...manifest.files, [path]: contents },
    sides: [
      { ...firstSide, files: omit(firstSide.files, [path]) },
      { ...secondSide, files: omit(secondSide.files, [path]) },
    ],
  });
}

/** The side a moved manifest becomes: its name, database, pair and flavor, with these files. */
function toPairSide(moved: RunManifest, files: Record<string, string>, name?: string): PairSide {
  return {
    ...(name === undefined ? {} : { name }),
    target: moved.target,
    dependencies: moved.dependencies,
    ...(moved.guestFlavor === undefined ? {} : { guestFlavor: moved.guestFlavor }),
    files,
  };
}

/**
 * Create a side-by-side project from one-version projects
 *
 * `base` is the project both sides start from, or one project per side. Each side runs on its pair's database, whatever
 * its base's. "separate" gives each side a copy of every file but the seed, from its own base; "shared" keeps the first
 * base's files for both, except the schema entrypoint of sides on two databases, which each side takes from its own
 * base. The seed is always the first base's, shared. A side whose base is on the other database keeps that schema as
 * written, so its compiler reports what to rewrite. `guestFlavors` sets each side's guest flavor; without it each side
 * keeps its base's flavor where its pair ships it.
 *
 * A pair seeds from `seed.ts` only, so a base seeding from another file is refused: its relative imports would change
 * meaning if it moved. A seed that is off has no entrypoint, so a file that was the seed under another name is a
 * plain helper here, with a copy per side across release lines.
 *
 * Throws `RunManifestValidationError` when a side is invalid on its pair, `PairManifestValidationError` when the result
 * is invalid, such as "shared" across release lines, and an error naming the side, such as "rc.5 (2): ...", when a pair
 * has no guest in the flavor or cannot run the files the side ends up with. Also throws when a base seeds from another
 * file than `seed.ts`, and for "separate" when only the second base has `seed.ts`, which would be dropped.
 */
export function createPairManifest(
  base: RunManifest | readonly [RunManifest, RunManifest],
  tuples: readonly [SupportedRuntimeTuple, SupportedRuntimeTuple],
  files: PairFilesStart,
  guestFlavors?: readonly [GuestFlavor, GuestFlavor],
): PairManifest {
  const [firstBase, secondBase]: readonly [RunManifest, RunManifest] = isRunManifestPair(base) ? base : [base, base];
  const [firstTuple, secondTuple] = tuples;

  if (firstTuple === undefined || secondTuple === undefined) {
    throw new Error("A side-by-side project has two sides");
  }

  assertSeedsFromPairSeedPath(firstBase);
  assertSeedsFromPairSeedPath(secondBase);

  if (
    files === "separate" &&
    !Object.hasOwn(firstBase.files, PAIR_SEED_PATH) &&
    Object.hasOwn(secondBase.files, PAIR_SEED_PATH)
  ) {
    throw new Error(
      `${PAIR_SEED_PATH} would be dropped: only the second project has it, and both sides share the first project's. Add it to the first project.`,
    );
  }

  const pinLabels = toPairSideLabels([
    toPinnedLabelSource(firstBase, firstTuple, guestFlavors?.[0]),
    toPinnedLabelSource(secondBase, secondTuple, guestFlavors?.[1]),
  ]);
  // Imports are checked once, on the files each side finally runs: below, after the files are placed.
  const firstSide = pinSideToPair(firstBase, firstTuple, guestFlavors?.[0], pinLabels[0]);
  const secondSide = pinSideToPair(secondBase, secondTuple, guestFlavors?.[1], pinLabels[1]);

  // The seed file stays shared even while the seed is off, so turning it back on finds one copy.
  const seedFiles = [PAIR_SEED_PATH];
  const crossDatabase = firstSide.target.dialect !== secondSide.target.dialect;
  const schemaFiles = crossDatabase ? [firstBase.entrypoints.schema] : [];
  const firstFiles = files === "separate" ? omit(firstBase.files, seedFiles) : pick(firstBase.files, schemaFiles);
  const secondFiles = files === "separate" ? omit(secondBase.files, seedFiles) : pick(secondBase.files, schemaFiles);
  const sharedFiles = omit(firstBase.files, Object.keys(firstFiles));

  return assertPairImportsAvailable(
    parsePairManifest({
      kind: PAIR_MANIFEST_KIND,
      manifestVersion: PAIR_MANIFEST_VERSION,
      entrypoints: firstBase.entrypoints,
      files: sharedFiles,
      sides: [toPairSide(firstSide, firstFiles), toPairSide(secondSide, secondFiles)],
      ...(firstBase.env === undefined ? {} : { env: firstBase.env }),
      ...(firstBase.randomSeed === undefined ? {} : { randomSeed: firstBase.randomSeed }),
      ...(firstBase.seedGeneratorVersion === undefined ? {} : { seedGeneratorVersion: firstBase.seedGeneratorVersion }),
    }),
  );
}

/**
 * Check that each side's pair serves the files that side runs, and return the pair
 *
 * A side moved to a pair runs with the files the final pair gives it, shared and its own, which can differ from the
 * files it was moved with: such as the first base's shared files on a second side. Throws as `assertImportsAvailable`,
 * with the side's label first, such as "rc.5 (2): effect is not available with orm 1.0.0-rc.5 · kit 1.0.0-rc.5".
 */
function assertPairImportsAvailable(manifest: PairManifest): PairManifest {
  const labels = pairSideLabels(manifest);

  for (const side of PAIR_SIDES) {
    try {
      assertImportsAvailable(pairSide(manifest, side));
    } catch (cause) {
      throwWithSideLabel(labels[side], cause);
    }
  }

  return manifest;
}

/**
 * Pin a side's manifest to a pair, on that pair's database, without checking its imports
 *
 * The files it is pinned with may not be the ones it runs once placed in the pair, so `assertPairImportsAvailable`
 * checks the final ones. Throws an error starting with `label` when the pair has no guest in the flavor, and
 * `RunManifestValidationError` when the result is invalid.
 */
function pinSideToPair(
  manifest: RunManifest,
  tuple: SupportedRuntimeTuple,
  guestFlavor: GuestFlavor | undefined,
  label: string,
): RunManifest {
  try {
    return parseRunManifest(pinManifestToPair({ ...manifest }, tuple, guestFlavor));
  } catch (cause) {
    throwWithSideLabel(label, cause);
  }
}

/** What a side pinned from `manifest` to `tuple` is called before it joins the pair. */
function toPinnedLabelSource(
  manifest: Pick<RunManifest, "guestFlavor">,
  tuple: SupportedRuntimeTuple,
  guestFlavor: GuestFlavor | undefined,
  name?: string,
): PairSideLabelSource {
  return {
    name,
    ormVersion: tuple.ormVersion,
    guestFlavor: guestFlavor ?? resolveGuestFlavor(manifest),
    dialect: tuple.target.dialect,
  };
}

/** Throws when a project seeds from another file than `seed.ts`, the only seed of a side-by-side project. */
function assertSeedsFromPairSeedPath(manifest: RunManifest): void {
  const seedPath = manifest.entrypoints.seed;

  if (seedPath !== undefined && seedPath !== PAIR_SEED_PATH) {
    throw new Error(toRenamedSeedMessage(seedPath));
  }
}

function isRunManifestPair(
  base: RunManifest | readonly [RunManifest, RunManifest],
): base is readonly [RunManifest, RunManifest] {
  return Array.isArray(base);
}

/**
 * Move one side to another pair, on any database
 *
 * Its files stay as they are ("keep"), become a copy of the other side's ("copy"), or become one shared set with the
 * other side ("share"). `guestFlavor` sets the side's guest flavor. The side keeps its name, and may move to the
 * other side's release. A move across release lines gives each side its own copy of every shared file but the seed,
 * and cannot share. Sides on two databases each keep their own schema entrypoint: after a copy or a share, a side that
 * stays on its database keeps its own schema, and a side that moves to the other database keeps the schema it has, as
 * written, so its compiler reports what to rewrite. Throws when the new pair cannot run the side's files.
 */
export function changePairSide(
  manifest: PairManifest,
  side: PairSideIndex,
  tuple: SupportedRuntimeTuple,
  files: PairSideFiles,
  guestFlavor?: GuestFlavor,
): PairManifest {
  const oppositeSide = manifest.sides[otherSide(side)];
  const schemaPath = manifest.entrypoints.schema;
  const ownSchema = pairSide(manifest, side).files[schemaPath];
  const staysOnDatabase = manifest.sides[side].target.dialect === tuple.target.dialect;
  const name = manifest.sides[side].name;
  const movingLabel = toPinnedLabelSource(manifest.sides[side], tuple, guestFlavor, name);
  const labels = toPairSideLabels(
    side === 0
      ? [movingLabel, toPairSideLabelSource(oppositeSide)]
      : [toPairSideLabelSource(oppositeSide), movingLabel],
  );
  // Imports are checked once, on the files the side finally runs, by `assertPairImportsAvailable` below.
  const moved = pinSideToPair(pairSide(manifest, side), tuple, guestFlavor, labels[side]);
  const ownFiles = files === "copy" ? { ...oppositeSide.files } : files === "keep" ? manifest.sides[side].files : {};
  const changed = replaceSides(
    files === "share" ? { ...manifest, files: { ...manifest.files, ...oppositeSide.files } } : manifest,
    side === 0
      ? [toPairSide(moved, ownFiles, name), files === "share" ? { ...oppositeSide, files: {} } : oppositeSide]
      : [files === "share" ? { ...oppositeSide, files: {} } : oppositeSide, toPairSide(moved, ownFiles, name)],
  );
  if (files === "share" && isCrossLinePair(changed)) {
    // Throws: a pair across release lines shares only the seed.
    return parsePairManifest(changed);
  }

  const split = splitUnshareableFiles(changed);
  const keepsOwnSchema = files !== "keep" && staysOnDatabase && isCrossDatabasePair(split) && ownSchema !== undefined;

  return assertPairImportsAvailable(
    parsePairManifest(keepsOwnSchema ? setSideFile(split, side, schemaPath, ownSchema) : split),
  );
}

/** The pair with one side's own copy of `path` set to `contents`. */
function setSideFile(manifest: PairManifest, side: PairSideIndex, path: string, contents: string): PairManifest {
  const currentSide = manifest.sides[side];

  return replaceSide(manifest, side, { ...currentSide, files: { ...currentSide.files, [path]: contents } });
}

/** Get the same project with its sides in the other order. */
export function swapPairSides(manifest: PairManifest): PairManifest {
  return replaceSides(manifest, [manifest.sides[1], manifest.sides[0]]);
}

/** True for a known way to start a side-by-side project's files. */
export function isPairFilesStart(value: unknown): value is PairFilesStart {
  return value === "separate" || value === "shared";
}

const IMPORT_SPECIFIER_PATTERN =
  /(?:\bimport\s*(?:[\w*{}\s,$]+\s*from\s*)?|\bexport\s*[\w*{}\s,$]*\s*from\s*|\bimport\s*\(\s*)(["'])([^"']+)\1/g;

/**
 * Check the seed's imports
 *
 * Returns the imports the seed may not use, or an empty array. Both sides run one seed, so it only reaches
 * drizzle-seed, the runtime context and project files; anything else could differ between the pairs. The check is
 * lexical: it reads import and export-from specifiers, not what code runs.
 */
export function checkPairSeed(source: string): readonly string[] {
  const disallowedSpecifiers = new Set<string>();

  for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[2];

    if (specifier === undefined) {
      continue;
    }

    const isAllowed =
      specifier === "drizzle-seed" || specifier.startsWith(".") || specifier === RUNTIME_CONTEXT_SPECIFIER;

    if (!isAllowed) {
      disallowedSpecifiers.add(specifier);
    }
  }

  return [...disallowedSpecifiers];
}

/**
 * Explain why a side-by-side project's seed cannot run
 *
 * Returns the message that names the seed and the imports to remove, or undefined when the project has no seed or
 * its seed passes `checkPairSeed`.
 */
export function getPairSeedProblem(manifest: {
  entrypoints: { seed?: string };
  files: Readonly<Record<string, string>>;
}): string | undefined {
  const seedPath = manifest.entrypoints.seed;

  if (seedPath === undefined) {
    return undefined;
  }

  const disallowed = checkPairSeed(manifest.files[seedPath] ?? "");

  if (disallowed.length === 0) {
    return undefined;
  }

  return `${seedPath} seeds both sides, so it may only use drizzle-seed or db. Remove the import of ${disallowed.join(", ")}.`;
}
