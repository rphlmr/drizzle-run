import { pick } from "es-toolkit";
import * as z from "zod/mini";

import { RUN_MANIFEST_ISSUE_CODES, RunManifestSchema } from "../manifest/schema.ts";
import type { RunManifest } from "../manifest/types.ts";
import { releaseLineOf } from "../registry/selectors.ts";
import type { DataRecord, IssuePath } from "../shared/records.ts";
import { DataRecordSchema, refined, reportIssue, toContractIssues, withIssueCode } from "../shared/schema.ts";
import {
  PAIR_MANIFEST_KIND,
  PAIR_MANIFEST_VERSION,
  PAIR_SIDE_NAME_MAX_LENGTH,
  PAIR_SIDES,
  type PairManifest,
  type PairManifestIssue,
  type PairSideIndex,
} from "./types.ts";

type Payload = { issues: z.core.$ZodRawIssue[]; value: unknown };

/** The issue codes a side-by-side manifest reports beyond the base ones. */
export const PAIR_MANIFEST_ISSUE_CODES = [
  ...RUN_MANIFEST_ISSUE_CODES,
  "UNSUPPORTED_VERSION",
] as const satisfies readonly PairManifestIssue["code"][];

const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

/**
 * The seed file of every side-by-side project
 *
 * A pair seeds from `seed.ts` only, so the file is known while the seed is off: it stays shared, the seed switch can
 * turn it back on, and a pair across release lines shares only this file.
 */
export const PAIR_SEED_PATH = "seed.ts";

/** A side's name: plain text, trimmed, 1 to 40 characters. */
const PairSideNameSchema = z.string({ error: "A side's name is text." }).check(
  z.refine(
    (name) => name.length > 0 && name.length <= PAIR_SIDE_NAME_MAX_LENGTH,
    withIssueCode("INVALID_VALUE", `A side's name is 1 to ${PAIR_SIDE_NAME_MAX_LENGTH} characters.`),
  ),
  z.refine(
    (name) => name === name.trim() && !CONTROL_CHARACTER_PATTERN.test(name),
    withIssueCode("INVALID_VALUE", "A side's name is one line of text with no space at either end."),
  ),
);

/** One side as written: its name, its pins, checked later as part of its run manifest, and the files only it runs. */
const PairSideFieldsSchema = z.pipe(
  DataRecordSchema,
  z.strictObject({
    name: z.optional(PairSideNameSchema),
    target: z.optional(z.unknown()),
    dependencies: z.optional(z.unknown()),
    guestFlavor: z.optional(z.unknown()),
    files: DataRecordSchema,
  }),
);

const PairSidesSchema = z.pipe(
  refined<unknown[]>(
    (value) => Array.isArray(value) && value.length === PAIR_SIDES.length,
    withIssueCode("INVALID_VALUE", "A side-by-side project has exactly two sides."),
  ),
  z.tuple([PairSideFieldsSchema, PairSideFieldsSchema]),
);

/** The fields of a side-by-side manifest; each side's target, and the entrypoints, env and seed, are checked per side. */
const PairManifestFieldsSchema = z.strictObject({
  kind: z.literal(PAIR_MANIFEST_KIND, { error: `Expected "${PAIR_MANIFEST_KIND}".` }),
  manifestVersion: z.literal(PAIR_MANIFEST_VERSION, {
    error: `Expected manifest version ${PAIR_MANIFEST_VERSION}.`,
  }),
  entrypoints: z.optional(z.unknown()),
  files: DataRecordSchema,
  sides: PairSidesSchema,
  env: z.optional(z.unknown()),
  randomSeed: z.optional(z.unknown()),
  seedGeneratorVersion: z.optional(z.unknown()),
});

type PairManifestFields = z.output<typeof PairManifestFieldsSchema>;

/** Stops at a newer manifest version, so a newer manifest is told apart from a broken one. */
function rejectNewerVersion(manifest: DataRecord, payload: Payload): DataRecord {
  const version = manifest.manifestVersion;

  if (typeof version === "number" && Number.isInteger(version) && version > PAIR_MANIFEST_VERSION) {
    payload.issues.push({
      code: "custom",
      input: version,
      path: ["manifestVersion"],
      message: `This project uses side-by-side manifest version ${version}; this version of @drizzle-run/core reads up to version ${PAIR_MANIFEST_VERSION}.`,
      params: { code: "UNSUPPORTED_VERSION" },
    });
  }

  return manifest;
}

/** The text files of one side; none when the side or its files are not an object, which the side reports. */
function readTextFiles(side: unknown): Record<string, string> {
  const sideRecord = DataRecordSchema.safeParse(side);
  const files = sideRecord.success ? DataRecordSchema.safeParse(sideRecord.data.files) : undefined;

  if (files === undefined || !files.success) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(files.data).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/** The text files of each side, in side order; undefined unless there are exactly two sides. */
function readSideFiles(sides: unknown): readonly [Record<string, string>, Record<string, string>] | undefined {
  if (!Array.isArray(sides) || sides.length !== PAIR_SIDES.length) {
    return undefined;
  }

  return [readTextFiles(sides[0]), readTextFiles(sides[1])];
}

/**
 * Report each per-side file that is not text, where it is, instead of leaving it out of the side
 *
 * Returns the paths reported, by side, so the placement checks do not also call them missing.
 */
function reportNonTextSideFiles(sides: unknown, payload: Payload): Set<string>[] {
  const nonText: Set<string>[] = [];

  if (!Array.isArray(sides)) {
    return nonText;
  }

  for (const [side, value] of sides.entries()) {
    nonText[side] = new Set();
    const sideRecord = DataRecordSchema.safeParse(value);
    const files = sideRecord.success ? DataRecordSchema.safeParse(sideRecord.data.files) : undefined;

    if (files === undefined || !files.success) {
      continue;
    }

    for (const [path, content] of Object.entries(files.data)) {
      if (typeof content !== "string") {
        nonText[side]?.add(path);
        reportIssue(payload, {
          path: ["sides", side, "files", path],
          code: "INVALID_TYPE",
          message: `${path} must be the file's text.`,
        });
      }
    }
  }

  return nonText;
}

/** Check that a file is shared or per side but not both, both sides list the same files, and the seed is shared. */
function checkFilePlacement(fields: PairManifestFields, payload: Payload): void {
  const nonTextFiles: readonly (Set<string> | undefined)[] = reportNonTextSideFiles(fields.sides, payload);

  const sideFiles = readSideFiles(fields.sides);

  if (sideFiles === undefined) {
    return;
  }

  // Every path a side lists, text or not: a file reported as not text is still there, and still needs its pair.
  const listedFiles = PAIR_SIDES.map(
    (side) => new Set([...Object.keys(sideFiles[side]), ...(nonTextFiles[side] ?? [])]),
  );
  const sharedFiles = DataRecordSchema.safeParse(fields.files);

  for (const side of PAIR_SIDES) {
    const otherSide: PairSideIndex = side === 0 ? 1 : 0;

    for (const path of listedFiles[side]) {
      if (sharedFiles.success && Object.hasOwn(sharedFiles.data, path)) {
        reportIssue(payload, {
          path: ["sides", side, "files", path],
          code: "INVALID_VALUE",
          message: `${path} is shared, so it cannot also have a copy per side.`,
        });
      }

      if (!listedFiles[otherSide].has(path)) {
        reportIssue(payload, {
          path: ["sides", otherSide, "files"],
          code: "MISSING_FILE",
          message: `${path} has a copy per side, so both sides need one.`,
        });
      }
    }
  }

  const entrypoints = DataRecordSchema.safeParse(fields.entrypoints);
  const seed = entrypoints.success ? entrypoints.data.seed : undefined;

  if (typeof seed === "string" && seed !== PAIR_SEED_PATH) {
    reportIssue(payload, {
      path: ["entrypoints", "seed"],
      code: "INVALID_VALUE",
      message: toRenamedSeedMessage(seed),
    });
  }

  // On or off: a seed switched off keeps its one shared copy, so switching it back on needs no merge.
  for (const side of PAIR_SIDES) {
    if (listedFiles[side].has(PAIR_SEED_PATH)) {
      reportIssue(payload, {
        path: ["sides", side, "files", PAIR_SEED_PATH],
        code: "INVALID_VALUE",
        message: `${PAIR_SEED_PATH} is the seed file both sides share, on or off, so it cannot have a copy per side.`,
      });
    }
  }
}

/**
 * Say that a side-by-side project cannot seed from `seedPath`
 *
 * A pair seeds from `seed.ts` only. A seed under another name is refused rather than moved, since moving it would
 * change what its relative imports point at.
 */
export function toRenamedSeedMessage(seedPath: string): string {
  return `A side-by-side project seeds from ${PAIR_SEED_PATH}: rename ${seedPath} to ${PAIR_SEED_PATH} first.`;
}

/**
 * Where a side's run manifest issue lives in the pair: dependencies and per-side files under
 * `sides[i]`, shared files and the common fields at the top.
 */
function toPairIssuePath(path: IssuePath, side: PairSideIndex, sideFiles: DataRecord): IssuePath {
  if (path[0] === "target" || path[0] === "dependencies" || path[0] === "guestFlavor") {
    return ["sides", side, ...path];
  }

  if (path[0] === "files" && typeof path[1] === "string" && Object.hasOwn(sideFiles, path[1])) {
    return ["sides", side, ...path];
  }

  return path;
}

/**
 * Check each side as a run manifest on its own pair, then build the parsed pair
 *
 * A side's files that are not text are left out, as the side was always read.
 */
function toPairManifest(fields: PairManifestFields, payload: Payload): PairManifest {
  const sideManifests: RunManifest[] = [];
  const sideFiles = [readTextFiles(fields.sides[0]), readTextFiles(fields.sides[1])] as const;

  for (const side of PAIR_SIDES) {
    const result = RunManifestSchema.safeParse({
      kind: "drizzle-run",
      manifestVersion: 1,
      target: fields.sides[side].target,
      dependencies: fields.sides[side].dependencies,
      ...(fields.sides[side].guestFlavor === undefined ? {} : { guestFlavor: fields.sides[side].guestFlavor }),
      files: { ...fields.files, ...sideFiles[side] },
      entrypoints: fields.entrypoints,
      ...(fields.env === undefined ? {} : { env: fields.env }),
      ...(fields.randomSeed === undefined ? {} : { randomSeed: fields.randomSeed }),
      ...(fields.seedGeneratorVersion === undefined ? {} : { seedGeneratorVersion: fields.seedGeneratorVersion }),
    });

    if (result.success) {
      sideManifests.push(result.data);
      continue;
    }

    for (const issue of toContractIssues(result.error.issues, RUN_MANIFEST_ISSUE_CODES)) {
      reportIssue(payload, { ...issue, path: toPairIssuePath(issue.path, side, sideFiles[side]) });
    }
  }

  const [left, right] = sideManifests;

  if (left === undefined || right === undefined) {
    return z.NEVER;
  }

  if (releaseLineOf(left.dependencies["drizzle-orm"]) !== releaseLineOf(right.dependencies["drizzle-orm"])) {
    const sharedCode = Object.keys(fields.files).filter((path) => path !== PAIR_SEED_PATH);

    for (const path of sharedCode) {
      reportIssue(payload, {
        path: ["files", path],
        code: "INVALID_VALUE",
        message: `${path} is shared, but a Legacy side and a Next side share only the seed: give each side its own copy.`,
      });
    }

    if (sharedCode.length > 0) {
      return z.NEVER;
    }
  }

  if (left.target.dialect !== right.target.dialect && Object.hasOwn(fields.files, left.entrypoints.schema)) {
    reportIssue(payload, {
      path: ["files", left.entrypoints.schema],
      code: "INVALID_VALUE",
      message: `${left.entrypoints.schema} is shared, but sides on different databases need their own schema: give each side its own copy.`,
    });

    return z.NEVER;
  }

  const [leftName, rightName] = [fields.sides[0].name, fields.sides[1].name];

  return {
    kind: PAIR_MANIFEST_KIND,
    manifestVersion: PAIR_MANIFEST_VERSION,
    entrypoints: left.entrypoints,
    files: pick(left.files, Object.keys(fields.files)),
    sides: [
      {
        ...(leftName === undefined ? {} : { name: leftName }),
        target: left.target,
        dependencies: left.dependencies,
        ...(left.guestFlavor === undefined ? {} : { guestFlavor: left.guestFlavor }),
        files: pick(left.files, Object.keys(sideFiles[0])),
      },
      {
        ...(rightName === undefined ? {} : { name: rightName }),
        target: right.target,
        dependencies: right.dependencies,
        ...(right.guestFlavor === undefined ? {} : { guestFlavor: right.guestFlavor }),
        files: pick(right.files, Object.keys(sideFiles[1])),
      },
    ],
    ...(left.env === undefined ? {} : { env: left.env }),
    ...(left.randomSeed === undefined ? {} : { randomSeed: left.randomSeed }),
    ...(left.seedGeneratorVersion === undefined ? {} : { seedGeneratorVersion: left.seedGeneratorVersion }),
  };
}

/**
 * A side-by-side manifest
 *
 * Each side must be a valid run manifest on its own database and pair, both sides list the same per-side files, a
 * file is shared or per side but not both, and the seed entrypoint is shared. A Legacy side next to a Next side shares
 * only the seed, since the two lines differ in imports and APIs, and sides on different databases each have their own
 * schema. Both sides may run the same release, and a side's
 * optional name is trimmed plain text of 1 to 40 characters. A newer manifest version reports `UNSUPPORTED_VERSION`
 * alone.
 */
export const PairManifestSchema = z.pipe(
  z.pipe(
    z.pipe(DataRecordSchema, z.transform(rejectNewerVersion)),
    PairManifestFieldsSchema.check(z.superRefine(checkFilePlacement, { when: () => true })),
  ),
  z.transform(toPairManifest),
);
