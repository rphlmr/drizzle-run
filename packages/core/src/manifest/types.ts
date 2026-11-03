import type * as z from "zod/mini";

import type { GuestFlavor } from "../releases/catalog.ts";
import type {
  NextRunDependenciesSchema,
  RunDependencyPinsSchema,
  RunManifestTargetSchema,
  SEED_GENERATOR_VERSIONS,
  LegacyRunDependenciesSchema,
} from "./schema.ts";

/** The database dialect a run targets. */
export type RunManifestTarget = z.output<typeof RunManifestTargetSchema>;

/** Dependency pins of the Legacy release line. */
export type LegacyRunDependencies = z.output<typeof LegacyRunDependenciesSchema>;

/** Dependency pins of the Next release line. */
export type NextRunDependencies = z.output<typeof NextRunDependenciesSchema>;

/** Dependency pins of either release line. */
export type RunDependencyPins = z.output<typeof RunDependencyPinsSchema>;

/** A drizzle-seed generator version every guest accepts. */
export type SeedGeneratorVersion = (typeof SEED_GENERATOR_VERSIONS)[number];

/** The files a run executes, by role, each naming a manifest file. */
export type RunEntrypoints<Files extends Record<string, string>> = {
  schema: keyof Files & string;
  seed?: keyof Files & string;
  run?: keyof Files & string;
};

/**
 * A self-contained run: target, pinned pair, guest flavor, files, and entrypoints
 *
 * `dependencies` pins only `drizzle-orm` and `drizzle-kit`; companion libraries such as zod or effect run at the
 * versions the pair's guest ships. `guestFlavor` is left out for `slim`. `seedGeneratorVersion` is the drizzle-seed
 * generator version a `seed()` call uses when it names none, so both sides of a side by side seed the same rows.
 */
export type RunManifest<
  Files extends Record<string, string> = Record<string, string>,
  Entrypoints extends RunEntrypoints<Files> = RunEntrypoints<Files>,
  Dependencies extends RunDependencyPins = RunDependencyPins,
> = {
  kind: "drizzle-run";
  manifestVersion: 1;
  target: RunManifestTarget;
  dependencies: Dependencies;
  guestFlavor?: GuestFlavor;
  files: Files;
  entrypoints: Entrypoints;
  env?: Record<string, string>;
  randomSeed?: number;
  seedGeneratorVersion?: SeedGeneratorVersion;
};

/** One problem found in a run manifest, at a path inside it. */
export interface RunManifestIssue {
  path: readonly (string | number)[];
  code:
    | "INVALID_TYPE"
    | "UNKNOWN_FIELD"
    | "INVALID_VALUE"
    | "UNSUPPORTED_COMBINATION"
    | "NON_CANONICAL_PATH"
    | "MISSING_FILE"
    | "LIMIT_EXCEEDED";
  message: string;
}

/** A successful `safeParseRunManifest` result. */
export interface SafeParseRunManifestSuccess<Manifest extends RunManifest = RunManifest> {
  success: true;
  data: Manifest;
}

/** A failed `safeParseRunManifest` result with every issue found. */
export interface SafeParseRunManifestFailure {
  success: false;
  issues: readonly RunManifestIssue[];
}

/** The result of `safeParseRunManifest`. */
export type SafeParseRunManifestResult<Manifest extends RunManifest = RunManifest> =
  | SafeParseRunManifestSuccess<Manifest>
  | SafeParseRunManifestFailure;
