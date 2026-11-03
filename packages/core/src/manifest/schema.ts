import * as z from "zod/mini";

import { GUEST_FLAVORS, hasGuestFlavor, resolveGuestFlavor } from "../registry/guest-images.ts";
import { findSupportedTuple } from "../registry/selectors.ts";
import type { SupportedRuntimeTuple } from "../registry/types.ts";
import { listLinePackageVersions } from "../releases/catalog.ts";
import { DialectSchema } from "../releases/dialects.ts";
import { isCanonicalProjectPath, type DataRecord, type IssuePath } from "../shared/records.ts";
import { createDataRecordSchema, DataRecordSchema, refined, reportIssue, withIssueCode } from "../shared/schema.ts";
import type { RunManifest, RunManifestIssue } from "./types.ts";

/** Most files a run manifest may hold. */
export const MAX_RUN_FILES = 64;

/** Most UTF-8 bytes of project source a run manifest may hold, all files together. */
export const MAX_RUN_SOURCE_BYTES = 1024 * 1024;

/** Most UTF-8 bytes of environment keys and values a run manifest may hold, all of them together. */
export const MAX_RUN_ENV_BYTES = 64 * 1024;

/** The issue codes a run manifest reports beyond the base ones. */
export const RUN_MANIFEST_ISSUE_CODES = [
  "UNSUPPORTED_COMBINATION",
  "NON_CANONICAL_PATH",
  "MISSING_FILE",
  "LIMIT_EXCEEDED",
] as const satisfies readonly RunManifestIssue["code"][];

/** The file extensions a project file may have. */
export const PROJECT_FILE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".json", ".sql"] as const;

const EXECUTABLE_FILE_EXTENSIONS = PROJECT_FILE_EXTENSIONS.slice(0, 6);

/**
 * Whether a path could name a project file
 *
 * A canonical relative POSIX path with a project file extension, such as "schema.ts" or "lib/money.ts". Names such as
 * "toString" or "__proto__" never qualify, so a lookup by such a path cannot reach an object's prototype.
 */
export function isProjectFilePath(path: string): boolean {
  return isCanonicalProjectPath(path) && hasExtension(path, PROJECT_FILE_EXTENSIONS);
}

const ENTRYPOINT_NAMES = ["schema", "seed", "run"] as const;

/**
 * The drizzle-seed generator versions every guest accepts
 *
 * Legacy drizzle-seed knows versions 1 and 2, Next knows 1 to 4, so only these produce the same rows on both lines.
 */
export const SEED_GENERATOR_VERSIONS = ["1", "2"] as const;

type Payload = { issues: z.core.$ZodRawIssue[]; value: unknown };

/** Counts UTF-8 bytes without encoding, and stops counting once past `limitBytes`. */
function getUtf8ByteLength(value: string, limitBytes = Number.POSITIVE_INFINITY): number {
  let byteLength = 0;

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit <= 0x7f) {
      byteLength += 1;
    } else if (codeUnit <= 0x7ff) {
      byteLength += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      // A high surrogate followed by a low one is one 4-byte code point; a lone one encodes as U+FFFD.
      const nextCodeUnit = value.charCodeAt(index + 1);

      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        byteLength += 4;
        index += 1;
      } else {
        byteLength += 3;
      }
    } else {
      byteLength += 3;
    }

    if (byteLength > limitBytes) {
      return byteLength;
    }
  }

  return byteLength;
}

function hasExtension(path: string, extensions: readonly string[]): boolean {
  return extensions.some((extension) => path.endsWith(extension));
}

function isUnsignedInt32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

/** The database a run targets. */
export const RunManifestTargetSchema = z.pipe(
  DataRecordSchema,
  z.strictObject({
    dialect: DialectSchema,
  }),
);

/** Dependency pins of the Legacy release line: its ORM and Kit versions. */
export const LegacyRunDependenciesSchema = z.strictObject({
  "drizzle-orm": z.literal(listLinePackageVersions("legacy", "drizzle-orm")),
  "drizzle-kit": z.literal(listLinePackageVersions("legacy", "drizzle-kit")),
});

/**
 * Dependency pins of the Next release line: its ORM and Kit versions
 *
 * Which pair a manifest may pin is checked against the catalog.
 */
export const NextRunDependenciesSchema = z.strictObject({
  "drizzle-orm": z.literal(listLinePackageVersions("next", "drizzle-orm")),
  "drizzle-kit": z.literal(listLinePackageVersions("next", "drizzle-kit")),
});

/** Dependency pins of either release line. */
export const RunDependencyPinsSchema = z.union([LegacyRunDependenciesSchema, NextRunDependenciesSchema]);

/** Report a missing value with its own message, before the value's schema reads it. */
function requireValue(message: string) {
  return refined<unknown>((value) => value !== undefined, withIssueCode("INVALID_VALUE", message));
}

const EntrypointPathSchema = z.string({ error: "Entrypoints must be file paths." }).check(
  z.superRefine((path, payload) => {
    if (!isCanonicalProjectPath(path)) {
      reportIssue(payload, {
        code: "NON_CANONICAL_PATH",
        message: "Entrypoints must use canonical relative POSIX paths.",
      });
    }

    if (!hasExtension(path, EXECUTABLE_FILE_EXTENSIONS)) {
      reportIssue(payload, {
        code: "INVALID_VALUE",
        message: "Entrypoints must reference ESM TypeScript or JavaScript modules.",
      });
    }
  }),
);

/** The files a run executes, by role, each naming a manifest file. */
export const RunEntrypointsSchema = z.pipe(
  DataRecordSchema,
  z.strictObject({
    schema: z.pipe(requireValue("A schema entrypoint is required."), EntrypointPathSchema),
    seed: z.optional(EntrypointPathSchema),
    run: z.optional(EntrypointPathSchema),
  }),
);

/** Report drizzle-orm and drizzle-kit when they are not pinned, also when the pins are not an object at all. */
function checkCorePins(dependencies: DataRecord, payload: Payload, prefix: IssuePath = []): void {
  for (const requiredPackage of ["drizzle-orm", "drizzle-kit"] as const) {
    const version = dependencies[requiredPackage];

    if (typeof version !== "string" || version.length === 0) {
      reportIssue(payload, {
        path: [...prefix, requiredPackage],
        code: "INVALID_VALUE",
        message: `${requiredPackage} must be pinned to an exact supported version.`,
      });
    }
  }
}

const DependencyRecordSchema = DataRecordSchema.check(
  z.superRefine((dependencies, payload) => {
    checkCorePins(dependencies, payload);

    for (const [packageName, version] of Object.entries(dependencies)) {
      if (typeof version !== "string" || version.length === 0) {
        reportIssue(payload, {
          path: [packageName],
          code: "INVALID_TYPE",
          message: "Dependency versions must be non-empty strings pinned by the runtime catalog.",
        });
      }
    }
  }),
);

/** The first parent folder of `path` that is also a file in `files`, or undefined when there is none. */
function findFileFolder(path: string, files: Readonly<Record<string, unknown>>): string | undefined {
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
    const folder = path.slice(0, slash);

    if (Object.hasOwn(files, folder)) {
      return folder;
    }
  }

  return undefined;
}

const ProjectFilesSchema = DataRecordSchema.check(
  z.superRefine((files, payload) => {
    const fileEntries = Object.entries(files);
    let sourceBytes = 0;

    if (fileEntries.length > MAX_RUN_FILES) {
      reportIssue(payload, {
        code: "LIMIT_EXCEEDED",
        message: `A run manifest may contain at most ${MAX_RUN_FILES} files.`,
      });
    }

    for (const [path, source] of fileEntries) {
      const fileFolder = findFileFolder(path, files);

      if (fileFolder !== undefined) {
        reportIssue(payload, {
          path: [path],
          code: "INVALID_VALUE",
          message: `A file cannot sit inside another file: ${path} is inside ${fileFolder}.`,
        });
      }

      if (!isCanonicalProjectPath(path)) {
        reportIssue(payload, {
          path: [path],
          code: "NON_CANONICAL_PATH",
          message: "File paths must be canonical relative POSIX paths without empty, dot, or parent segments.",
        });
      }

      if (!hasExtension(path, PROJECT_FILE_EXTENSIONS)) {
        reportIssue(payload, {
          path: [path],
          code: "INVALID_VALUE",
          message: "Project files must use ESM source, JSON, or SQL file extensions.",
        });
      }

      if (typeof source !== "string") {
        reportIssue(payload, { path: [path], code: "INVALID_TYPE", message: "Project source must be text." });
        continue;
      }

      sourceBytes += getUtf8ByteLength(source, MAX_RUN_SOURCE_BYTES - sourceBytes);
    }

    if (sourceBytes > MAX_RUN_SOURCE_BYTES) {
      reportIssue(payload, {
        code: "LIMIT_EXCEEDED",
        message: `Project source may contain at most ${MAX_RUN_SOURCE_BYTES} UTF-8 bytes in total.`,
      });
    }
  }),
);

const EnvironmentSchema = DataRecordSchema.check(
  z.superRefine((env, payload) => {
    let envBytes = 0;

    for (const [key, value] of Object.entries(env)) {
      envBytes += getUtf8ByteLength(key, MAX_RUN_ENV_BYTES - envBytes);

      if (typeof value !== "string") {
        reportIssue(payload, { path: [key], code: "INVALID_TYPE", message: "Environment values must be text." });
        continue;
      }

      envBytes += getUtf8ByteLength(value, MAX_RUN_ENV_BYTES - envBytes);
    }

    if (envBytes > MAX_RUN_ENV_BYTES) {
      reportIssue(payload, {
        code: "LIMIT_EXCEEDED",
        message: `Synthetic environment keys and values may contain at most ${MAX_RUN_ENV_BYTES} UTF-8 bytes in total.`,
      });
    }
  }),
);

/** Every field of a run manifest, each checked on its own; `RunManifestSchema` adds the checks across fields. */
const RunManifestFieldsSchema = z.strictObject({
  kind: z.literal("drizzle-run", { error: 'Expected "drizzle-run".' }),
  manifestVersion: z.literal(1, { error: "Expected manifest version 1." }),
  target: RunManifestTargetSchema,
  dependencies: DependencyRecordSchema,
  guestFlavor: z.optional(z.enum(GUEST_FLAVORS, { error: `guestFlavor must be one of ${GUEST_FLAVORS.join(", ")}.` })),
  files: ProjectFilesSchema,
  entrypoints: RunEntrypointsSchema,
  env: z.optional(EnvironmentSchema),
  randomSeed: z.optional(refined<number>(isUnsignedInt32, { error: "randomSeed must be an unsigned 32-bit integer." })),
  seedGeneratorVersion: z.optional(
    z.enum(SEED_GENERATOR_VERSIONS, {
      error: `seedGeneratorVersion must be one of ${SEED_GENERATOR_VERSIONS.join(", ")}.`,
    }),
  ),
});

type RunManifestFields = z.output<typeof RunManifestFieldsSchema>;

/** Resolve the catalog tuple a manifest pins, when its target and both core pins are readable. */
function resolveManifestTuple(fields: DataRecord): SupportedRuntimeTuple | undefined {
  const target = RunManifestTargetSchema.safeParse(fields.target);
  const dependencies = DataRecordSchema.safeParse(fields.dependencies);

  if (!target.success || !dependencies.success) {
    return undefined;
  }

  const ormVersion = dependencies.data["drizzle-orm"];
  const kitVersion = dependencies.data["drizzle-kit"];

  if (typeof ormVersion !== "string" || typeof kitVersion !== "string") {
    return undefined;
  }

  return findSupportedTuple({ target: target.data, ormVersion, kitVersion });
}

/**
 * Check that the dependencies pin only the pair, and that the pair ships the requested guest flavor
 *
 * Companion libraries such as zod or effect are never pinned: a manifest runs them at the versions its pair ships.
 */
function checkPairPins(
  fields: RunManifestFields,
  dependencies: DataRecord,
  tuple: SupportedRuntimeTuple,
  payload: Payload,
): void {
  for (const packageName of Object.keys(dependencies)) {
    if (packageName !== "drizzle-orm" && packageName !== "drizzle-kit") {
      reportIssue(payload, {
        path: ["dependencies", packageName],
        code: "UNKNOWN_FIELD",
        message: `Only drizzle-orm and drizzle-kit are pinned; ${packageName} comes with the Drizzle release.`,
      });
    }
  }

  const guestFlavor = GUEST_FLAVORS.find((flavor) => flavor === resolveGuestFlavor(fields));

  if (guestFlavor !== undefined && !hasGuestFlavor(tuple, guestFlavor)) {
    reportIssue(payload, {
      path: ["guestFlavor"],
      code: "INVALID_VALUE",
      message: `Drizzle ORM ${tuple.ormVersion} has no ${guestFlavor} guest; choose a release that ships one.`,
    });
  }
}

/** Check the pins against the catalog and every entrypoint against the files, even when another field failed. */
function checkAcrossFields(fields: RunManifestFields, payload: Payload): void {
  const dependencies = DataRecordSchema.safeParse(fields.dependencies);
  const target = RunManifestTargetSchema.safeParse(fields.target);

  if (!dependencies.success) {
    checkCorePins({}, payload, ["dependencies"]);
  }

  // Check the pinned pair
  if (dependencies.success && target.success) {
    const tuple = resolveManifestTuple(fields);

    if (tuple === undefined) {
      reportIssue(payload, {
        path: ["dependencies"],
        code: "UNSUPPORTED_COMBINATION",
        message: "The pinned Drizzle ORM and Kit versions are not an admitted pair for this database.",
      });
    } else {
      checkPairPins(fields, dependencies.data, tuple, payload);
    }
  }

  // Check that every entrypoint names a file
  const files = DataRecordSchema.safeParse(fields.files);
  const entrypoints = DataRecordSchema.safeParse(fields.entrypoints);

  if (!entrypoints.success) {
    return;
  }

  for (const entrypointName of ENTRYPOINT_NAMES) {
    const entrypoint = entrypoints.data[entrypointName];
    const hasFile =
      files.success && typeof entrypoint === "string" && Object.hasOwn(files.data, entrypoint)
        ? typeof files.data[entrypoint] === "string"
        : false;

    if (typeof entrypoint === "string" && !hasFile) {
      reportIssue(payload, {
        path: ["entrypoints", entrypointName],
        code: "MISSING_FILE",
        message: `Entrypoint file does not exist: ${entrypoint}.`,
      });
    }
  }
}

/** Build the parsed manifest, with its dependency pins typed by the release line its tuple belongs to. */
function toRunManifest(fields: RunManifestFields, payload: Payload): RunManifest {
  const tuple = resolveManifestTuple(fields);
  const pinsSchema = tuple?.releaseLine === "next" ? NextRunDependenciesSchema : LegacyRunDependenciesSchema;
  const dependencyPins = pinsSchema.safeParse(fields.dependencies);

  if (!dependencyPins.success) {
    reportIssue(payload, {
      path: ["dependencies"],
      code: "UNSUPPORTED_COMBINATION",
      message: "The dependency pins do not match the resolved runtime tuple.",
    });

    return z.NEVER;
  }

  const { schema, seed, run } = fields.entrypoints;
  const guestFlavor = resolveGuestFlavor(fields);

  return {
    kind: fields.kind,
    manifestVersion: fields.manifestVersion,
    target: fields.target,
    dependencies: dependencyPins.data,
    // Slim is the default, so it is left out: every slim manifest has one form.
    ...(guestFlavor === "slim" ? {} : { guestFlavor }),
    files: Object.fromEntries(
      Object.entries(fields.files).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    entrypoints: {
      schema,
      ...(seed === undefined ? {} : { seed }),
      ...(run === undefined ? {} : { run }),
    },
    ...(fields.env === undefined
      ? {}
      : {
          env: Object.fromEntries(
            Object.entries(fields.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
          ),
        }),
    ...(fields.randomSeed === undefined ? {} : { randomSeed: fields.randomSeed }),
    ...(fields.seedGeneratorVersion === undefined ? {} : { seedGeneratorVersion: fields.seedGeneratorVersion }),
  };
}

/**
 * A self-contained run manifest
 *
 * Checks every field, the pinned pair against the catalog, file paths and extensions, entrypoints, and the size
 * limits, and reports every issue it finds. Its output is a detached copy with typed dependency pins.
 */
export const RunManifestSchema = z.pipe(
  z.pipe(
    createDataRecordSchema(),
    RunManifestFieldsSchema.check(z.superRefine(checkAcrossFields, { when: () => true })),
  ),
  z.transform(toRunManifest),
);
