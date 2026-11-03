import { omit, pick, uniqBy } from "es-toolkit";
import * as z from "zod/mini";

import { assertImportsAvailable } from "../manifest/imports.ts";
import {
  findRetiredPair,
  followInPlaceRelease,
  pinManifestToPair,
  type RetiredPair,
} from "../manifest/retired-pair.ts";
import type { RunManifest } from "../manifest/types.ts";
import { parseRunManifest, safeParseRunManifest } from "../manifest/validation.ts";
import { resolveGuestFlavor, type GuestFlavor } from "../registry/guest-images.ts";
import { listSupportedTuples } from "../registry/selectors.ts";
import type { SupportedRuntimeTuple } from "../registry/types.ts";
import { GUEST_FLAVORS } from "../releases/catalog.ts";
import { DialectSchema } from "../releases/dialects.ts";
import { formatIssuePath } from "../shared/records.ts";
import { DataRecordSchema, toContractIssues } from "../shared/schema.ts";
import { PAIR_MANIFEST_ISSUE_CODES, PairManifestSchema } from "./schema.ts";
import { canSharePairFile } from "./sharing.ts";
import { pairSideLabels, throwWithSideLabel, toPairSideLabels, type PairSideLabelSource } from "./side-label.ts";
import {
  PAIR_MANIFEST_KIND,
  PAIR_SIDES,
  type PairManifest,
  type PairManifestIssue,
  type PairSideIndex,
  type SafeParsePairManifestResult,
} from "./types.ts";

/** Thrown by `parsePairManifest` with every issue found, one per message line. */
export class PairManifestValidationError extends TypeError {
  readonly issues: readonly PairManifestIssue[];

  constructor(issues: readonly PairManifestIssue[]) {
    super(issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`).join("\n"));
    this.name = "PairManifestValidationError";
    this.issues = issues;
  }
}

/**
 * Validate a side-by-side manifest
 *
 * Each side must be a valid run manifest on its own pair, both sides list the same per-side files, a file is shared
 * or per side but not both, and the seed entrypoint is shared. Never throws for invalid input.
 */
export function safeParsePairManifest(input: unknown): SafeParsePairManifestResult {
  const result = PairManifestSchema.safeParse(input);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const issues = uniqBy(toContractIssues(result.error.issues, PAIR_MANIFEST_ISSUE_CODES), (issue) =>
    JSON.stringify([issue.path, issue.code, issue.message]),
  );

  return { success: false, issues };
}

/**
 * Parse a side-by-side manifest
 *
 * Throws `PairManifestValidationError` with every issue `safeParsePairManifest` finds.
 */
export function parsePairManifest(input: unknown): PairManifest {
  const result = safeParsePairManifest(input);

  if (!result.success) {
    throw new PairManifestValidationError(result.issues);
  }

  return result.data;
}

const PairManifestLikeSchema = z.pipe(DataRecordSchema, z.looseObject({ kind: z.literal(PAIR_MANIFEST_KIND) }));

/** True when a value claims to be a side-by-side manifest, valid or not. */
export function isPairManifestLike(value: unknown): boolean {
  return PairManifestLikeSchema.safeParse(value).success;
}

const PairSidesInputSchema = z.looseObject({
  files: z.optional(DataRecordSchema),
  sides: z.tuple([DataRecordSchema, DataRecordSchema]),
});

type PairSidesInput = z.infer<typeof PairSidesInputSchema>;

// Must build the side manifest as `pairSide` builds it for a parsed pair.
function toSideManifest(pair: PairSidesInput, side: Record<string, unknown>): Record<string, unknown> {
  const sideFiles = DataRecordSchema.safeParse(side.files);

  return {
    kind: "drizzle-run",
    manifestVersion: 1,
    target: side.target,
    dependencies: side.dependencies,
    ...(side.guestFlavor === undefined ? {} : { guestFlavor: side.guestFlavor }),
    files: { ...pair.files, ...(sideFiles.success ? sideFiles.data : {}) },
    entrypoints: pair.entrypoints,
    ...(pair.env === undefined ? {} : { env: pair.env }),
    ...(pair.randomSeed === undefined ? {} : { randomSeed: pair.randomSeed }),
  };
}

function toMovedSide(side: Record<string, unknown>, moved: Record<string, unknown>): Record<string, unknown> {
  // A flavor the pair does not ship moves to slim, which the moved manifest leaves out; so does the side.
  const { guestFlavor: _sideFlavor, ...sideFields } = side;
  const { guestFlavor } = moved;

  return {
    ...sideFields,
    target: moved.target,
    dependencies: moved.dependencies,
    ...(guestFlavor === undefined ? {} : { guestFlavor }),
  };
}

function followSideInPlaceRelease(pair: PairSidesInput, side: Record<string, unknown>): Record<string, unknown> {
  const sideManifest = toSideManifest(pair, side);
  const followed = followInPlaceRelease(sideManifest);

  if (followed === sideManifest) {
    return side;
  }

  const moved = safeParseRunManifest(followed);

  return moved.success ? toMovedSide(side, moved.data) : side;
}

/**
 * Follow an in-place Legacy release on each side
 *
 * A side on an older Legacy version moves to the current Legacy pair, as a one-version manifest does, so a saved or
 * shared side by side keeps opening after a Legacy fix release. Anything else is returned as is.
 */
export function followPairInPlaceRelease(input: unknown): unknown {
  const pair = PairSidesInputSchema.safeParse(input);

  if (!pair.success) {
    return input;
  }

  const sides = [
    followSideInPlaceRelease(pair.data, pair.data.sides[0]),
    followSideInPlaceRelease(pair.data, pair.data.sides[1]),
  ];

  if (sides[0] === pair.data.sides[0] && sides[1] === pair.data.sides[1]) {
    return input;
  }

  return { ...pair.data, sides };
}

/**
 * Find the older Legacy pair a side by side was written on
 *
 * The pair of the first side on an older Legacy version, when following the Legacy release on each side makes the
 * manifest valid. Undefined for a supported manifest and for one with any other problem, such as a removed Next pair.
 */
export function findInPlacePairRelease(input: unknown): RetiredPair | undefined {
  const pair = PairSidesInputSchema.safeParse(input);

  if (!pair.success) {
    return undefined;
  }

  const followed = followPairInPlaceRelease(input);

  if (followed === input || !safeParsePairManifest(followed).success) {
    return undefined;
  }

  for (const side of pair.data.sides) {
    const retiredPair = findRetiredPair(toSideManifest(pair.data, side));

    if (retiredPair !== undefined) {
      return retiredPair;
    }
  }

  return undefined;
}

/** A side of a side by side on an ORM/Kit pair the catalog no longer ships, with no in-place successor. */
export interface RetiredPairSide extends RetiredPair {
  side: PairSideIndex;
  /** The side's name, when it has one. */
  name?: string;
  /** The run manifest the side runs, as written for the removed pair. */
  manifest: Record<string, unknown>;
}

/** The release one side of a side by side moves to: a supported pair and, optionally, its guest flavor. */
export interface PairSideRelease {
  side: PairSideIndex;
  tuple: SupportedRuntimeTuple;
  guestFlavor?: GuestFlavor;
}

/**
 * Find the sides of a side by side that need a release chosen
 *
 * After each side on an older Legacy version follows the Legacy pair, the sides still on a removed pair, such as a
 * removed Next pair. Undefined for a valid manifest, and for one that a supported pair on those sides cannot make valid.
 */
export function findRetiredPairSides(input: unknown): readonly RetiredPairSide[] | undefined {
  const followed = PairSidesInputSchema.safeParse(followPairInPlaceRelease(input));

  if (!followed.success || safeParsePairManifest(followed.data).success) {
    return undefined;
  }

  const retiredSides: RetiredPairSide[] = [];

  for (const side of PAIR_SIDES) {
    const sideFields = followed.data.sides[side];
    const manifest = toSideManifest(followed.data, sideFields);
    const retiredPair = findRetiredPair(manifest);
    const name = typeof sideFields.name === "string" ? sideFields.name : undefined;

    if (retiredPair !== undefined) {
      retiredSides.push({ ...retiredPair, side, ...(name === undefined ? {} : { name }), manifest });
    }
  }

  if (retiredSides.length === 0 || !canMoveRetiredSides(followed.data, retiredSides)) {
    return undefined;
  }

  return retiredSides;
}

function canMoveRetiredSides(pair: PairSidesInput, retiredSides: readonly RetiredPairSide[]): boolean {
  const [first, second] = retiredSides.map((retired) =>
    listSupportedTuples(retired.target).map((tuple) => ({ side: retired.side, tuple })),
  );
  const combinations =
    second === undefined
      ? (first ?? []).map((release) => [release])
      : (first ?? []).flatMap((firstRelease) => second.map((secondRelease) => [firstRelease, secondRelease]));

  return combinations.some((releases) => {
    try {
      moveSides(pair, releases, { checkImports: false });

      return true;
    } catch {
      return false;
    }
  });
}

function moveSides(
  pair: PairSidesInput,
  releases: readonly PairSideRelease[],
  { checkImports }: { checkImports: boolean },
): PairManifest {
  const sides: [Record<string, unknown>, Record<string, unknown>] = [pair.sides[0], pair.sides[1]];
  const movedSides = new Map<PairSideIndex, RunManifest>();
  const pinLabels = toMovingSideLabels(pair, releases);

  for (const { side, tuple, guestFlavor } of releases) {
    const sideManifest = toSideManifest(pair, sides[side]);
    let moved: RunManifest;

    try {
      moved = parseRunManifest(pinManifestToPair(sideManifest, tuple, guestFlavor));
    } catch (cause) {
      throwWithSideLabel(pinLabels[side], cause);
    }

    movedSides.set(side, moved);
    sides[side] = toMovedSide(sides[side], moved);
  }

  const movedPair = parsePairManifest(splitUnshareableSideFiles(pair, sides));

  if (!checkImports) {
    return movedPair;
  }

  const labels = pairSideLabels(movedPair);

  for (const [side, moved] of movedSides) {
    try {
      assertImportsAvailable(moved);
    } catch (cause) {
      throwWithSideLabel(labels[side], cause);
    }
  }

  return movedPair;
}

const LabelledSideSchema = z.looseObject({
  name: z.optional(z.string()),
  target: z.looseObject({ dialect: DialectSchema }),
  dependencies: z.looseObject({ "drizzle-orm": z.string() }),
  guestFlavor: z.optional(z.enum(GUEST_FLAVORS)),
});

/**
 * Get what each side is called while some sides move to `releases`, for an error before the moved pair exists
 *
 * A moving side reads as its new release; a side that does not read as a side at all goes by "side 1" or "side 2".
 */
function toMovingSideLabels(pair: PairSidesInput, releases: readonly PairSideRelease[]): readonly [string, string] {
  const toSource = (side: PairSideIndex): PairSideLabelSource | undefined => {
    const release = releases.find((candidate) => candidate.side === side);
    const fields = LabelledSideSchema.safeParse(pair.sides[side]);
    const name = fields.success ? fields.data.name : undefined;

    if (release !== undefined) {
      return {
        name,
        ormVersion: release.tuple.ormVersion,
        guestFlavor: release.guestFlavor ?? (fields.success ? resolveGuestFlavor(fields.data) : "slim"),
        dialect: release.tuple.target.dialect,
      };
    }

    return fields.success
      ? {
          name,
          ormVersion: fields.data.dependencies["drizzle-orm"],
          guestFlavor: resolveGuestFlavor(fields.data),
          dialect: fields.data.target.dialect,
        }
      : undefined;
  };
  const first = toSource(0);
  const second = toSource(1);

  if (first === undefined || second === undefined) {
    return ["side 1", "side 2"];
  }

  return toPairSideLabels([first, second]);
}

/**
 * Give each side its own copy of the shared files its moved sides cannot share
 *
 * Moving one side to another release line or database can leave files shared that the sides cannot run one copy of;
 * they get a copy per side, as `changePairSide` gives them. Every unshareable file is split, so a shared schema
 * between two databases that a pair saved before the rule existed is repaired by the same move. A pair whose sides do
 * not parse is left for the pair schema to report.
 */
function splitUnshareableSideFiles(
  pair: PairSidesInput,
  sides: readonly [Record<string, unknown>, Record<string, unknown>],
): PairSidesInput {
  const first = safeParseRunManifest(toSideManifest(pair, sides[0]));
  const second = safeParseRunManifest(toSideManifest(pair, sides[1]));
  const sharedFiles = pair.files ?? {};

  if (!first.success || !second.success) {
    return { ...pair, sides: [...sides] };
  }

  const movedPair = { entrypoints: first.data.entrypoints, sides: [first.data, second.data] } as const;
  const unshareable = Object.keys(sharedFiles).filter((path) => !canSharePairFile(movedPair, path));
  const copies = pick(sharedFiles, unshareable);

  const withCopies = (side: Record<string, unknown>) => {
    const sideFiles = DataRecordSchema.safeParse(side.files);

    return { ...side, files: { ...copies, ...(sideFiles.success ? sideFiles.data : {}) } };
  };

  return {
    ...pair,
    files: omit(sharedFiles, unshareable),
    sides: [withCopies(sides[0]), withCopies(sides[1])],
  };
}

/**
 * Move the retired sides of a side by side to the chosen releases
 *
 * Sides on an older Legacy version follow the Legacy pair first; a side with no release given stays as it is. A shared
 * file the moved sides cannot run one copy of, such as any file but the seed for a Legacy side and a Next side, gets a
 * copy per side. Throws an error naming the side, such as "rc.5 (2): ...", when a pair has no guest in the chosen flavor
 * or cannot run the side's files, `RunManifestValidationError` when a moved side is invalid, and
 * `PairManifestValidationError` when the result is invalid for another reason.
 */
export function moveRetiredPairSides(input: unknown, releases: readonly PairSideRelease[]): PairManifest {
  const followed = followPairInPlaceRelease(input);
  const pair = PairSidesInputSchema.safeParse(followed);

  if (!pair.success) {
    return parsePairManifest(followed);
  }

  return moveSides(pair.data, releases, { checkImports: true });
}
