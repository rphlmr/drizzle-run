import type { GuestFlavor } from "../releases/catalog.ts";
import type { Dialect } from "../releases/dialects.ts";
import type { NextRunDependencies, RunManifest, SeedGeneratorVersion, LegacyRunDependencies } from "./types.ts";
import { parseRunManifest } from "./validation.ts";

/** A run manifest as written in source, before parsing. */
export type RunManifestDefinition =
  | {
      kind: "drizzle-run";
      manifestVersion: 1;
      target: { dialect: Dialect };
      dependencies: LegacyRunDependencies;
      guestFlavor?: GuestFlavor;
      files: Record<string, string>;
      entrypoints: { schema: string; seed?: string; run?: string };
      env?: Record<string, string>;
      randomSeed?: number;
      seedGeneratorVersion?: SeedGeneratorVersion;
    }
  | {
      kind: "drizzle-run";
      manifestVersion: 1;
      target: { dialect: Dialect };
      dependencies: NextRunDependencies;
      guestFlavor?: GuestFlavor;
      files: Record<string, string>;
      entrypoints: { schema: string; seed?: string; run?: string };
      env?: Record<string, string>;
      randomSeed?: number;
      seedGeneratorVersion?: SeedGeneratorVersion;
    };

type KnownManifestFields = keyof RunManifestDefinition;

type DependencyKeys<Manifest> = Manifest extends { dependencies: infer Dependencies }
  ? Dependencies extends LegacyRunDependencies
    ? keyof LegacyRunDependencies
    : Dependencies extends NextRunDependencies
      ? keyof NextRunDependencies
      : never
  : never;

type DependencyShape<Manifest> = Manifest extends {
  dependencies: infer Dependencies extends LegacyRunDependencies | NextRunDependencies;
}
  ? Dependencies
  : never;

type FilesOf<Manifest> = Manifest extends { files: infer Files extends Record<string, string> } ? Files : never;

type EntrypointsOf<Manifest> = Manifest extends { entrypoints: infer Entrypoints } ? Entrypoints : never;

type ReferencedFilesExist<Manifest> =
  EntrypointsOf<Manifest> extends { schema: infer Schema }
    ? Schema extends keyof FilesOf<Manifest>
      ? EntrypointsOf<Manifest> extends { seed: infer Seed }
        ? Seed extends keyof FilesOf<Manifest>
          ? EntrypointsOf<Manifest> extends { run: infer Run }
            ? Run extends keyof FilesOf<Manifest>
              ? true
              : false
            : true
          : false
        : EntrypointsOf<Manifest> extends { run: infer Run }
          ? Run extends keyof FilesOf<Manifest>
            ? true
            : false
          : true
      : false
    : false;

type ValidManifestShape<Manifest> = Manifest extends RunManifestDefinition
  ? Exclude<keyof Manifest, KnownManifestFields> extends never
    ? Exclude<keyof Manifest["target"], "dialect"> extends never
      ? Exclude<keyof Manifest["entrypoints"], "schema" | "seed" | "run"> extends never
        ? Exclude<keyof Manifest["dependencies"], DependencyKeys<Manifest>> extends never
          ? DependencyShape<Manifest> extends never
            ? never
            : ReferencedFilesExist<Manifest> extends true
              ? Manifest
              : never
          : never
        : never
      : never
    : never
  : never;

/**
 * Define a run manifest in source
 *
 * Keeps the literal manifest type, rejects unknown fields and missing entrypoint files at the type level, and throws
 * a `RunManifestValidationError` when the module loads if the manifest is invalid.
 */
export function defineRunManifest<const Manifest extends RunManifestDefinition>(
  manifest: Manifest & ValidManifestShape<Manifest>,
): Manifest {
  parseRunManifest(manifest);

  return manifest;
}

/** A defined run manifest, usable wherever a `RunManifest` is expected. */
export type DefinedRunManifest<Manifest extends RunManifestDefinition> = Manifest & RunManifest;
