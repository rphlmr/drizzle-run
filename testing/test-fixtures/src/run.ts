import {
  listSupportedTuples,
  type DatabaseTarget,
  type Dialect,
  type RuntimeReleaseLine,
  type SupportedRuntimeTuple,
} from "@drizzle-run/core/catalog";
import { toRecordedGuest, type PhaseTimings, type RecordedGuest, type RunResult } from "@drizzle-run/core/contracts";
import { parseRunManifest, type RunManifest } from "@drizzle-run/core/manifest";

/**
 * Get the catalog's tuple for a target on a release line
 *
 * Read from the catalog, so a fix release on either line needs no fixture edit. Throws when the catalog ships no pair
 * of that line for the target.
 */
export function fixtureTuple(target: DatabaseTarget, releaseLine: RuntimeReleaseLine): SupportedRuntimeTuple {
  const tuple = listSupportedTuples(target).find((candidate) => candidate.releaseLine === releaseLine);

  if (tuple === undefined) {
    throw new Error(`The catalog ships no ${releaseLine} pair for ${target.dialect}`);
  }

  return { ...tuple, target: { ...tuple.target } };
}

/** What `projectManifest` varies besides its dialect. */
export interface ProjectManifestOptions {
  /** Defaults to Legacy. */
  releaseLine?: RuntimeReleaseLine;
  /** Adds a `seed.ts` file and its `seed` entrypoint, the one seed file a side-by-side project keeps. Defaults to none. */
  seed?: boolean;
}

/** A small valid project, on the Legacy pair unless `releaseLine` picks Next, and without a seed unless `seed` adds one. */
export function projectManifest(
  dialect: Dialect = "postgresql",
  { releaseLine = "legacy", seed = false }: ProjectManifestOptions = {},
): RunManifest {
  const tuple = fixtureTuple({ dialect }, releaseLine);

  return parseRunManifest({
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect },
    dependencies: { "drizzle-orm": tuple.ormVersion, "drizzle-kit": tuple.kitVersion },
    files: {
      "schema.ts": "export {};\n",
      "query.ts": 'import { db } from "@drizzle-run/runtime/context";\n\n// next\n',
      ...(seed ? { "seed.ts": 'import { db } from "@drizzle-run/runtime/context";\n\n// seed\n' } : {}),
    },
    entrypoints: { schema: "schema.ts", ...(seed ? { seed: "seed.ts" } : {}), run: "query.ts" },
  });
}

/** The recorded guest of the Legacy pair's slim image, as a recording stores it. */
export function legacyGuest(): RecordedGuest {
  const guest = toRecordedGuest(projectManifest());

  if (guest === null) {
    throw new Error("Expected the catalog to ship the slim Legacy guest");
  }

  return guest;
}

/** What a `fakeRunResult` varies besides its outcome. */
export interface FakeRunOptions {
  /** Defaults to PostgreSQL. */
  target?: DatabaseTarget;
  /** The release line of the run's tuple, read from the catalog for `target`. Defaults to Legacy. */
  releaseLine?: RuntimeReleaseLine;
  /** Defaults to none. */
  displays?: RunResult["displays"];
  /** The error message of a failed run. */
  message?: string;
  /** Defaults to none. */
  timings?: PhaseTimings;
}

/**
 * A complete `RunResult` for fakes
 *
 * Only the outcome and the options vary: a PostgreSQL run on the Legacy pair with no displays by default.
 */
export function fakeRunResult(outcome: RunResult["outcome"], options: FakeRunOptions = {}): RunResult {
  const target = options.target ?? { dialect: "postgresql" };
  const tuple = fixtureTuple(target, options.releaseLine ?? "legacy");
  const displays = options.displays ?? [];
  const evidence = {
    version: 1 as const,
    target,
    tuple: { id: tuple.id, target, ormVersion: tuple.ormVersion, kitVersion: tuple.kitVersion },
    random: {
      effectiveSeed: 1,
      source: "provided" as const,
      derivation: "run-manifest-sha256-u32-v1" as const,
      generator: "mulberry32-v1" as const,
    },
    phases: [],
    diagnostics: [],
    sql: [],
    logs: [],
    value: { type: "undefined" as const },
    displays,
    events: displays.map((payload, index) => ({ type: "display" as const, sequence: index + 1, payload })),
    cleanupErrors: [],
    cleanup: { guest: { mode: "graceful" as const }, database: { mode: "graceful" as const } },
    timings: options.timings ?? {},
  };

  switch (outcome) {
    case "succeeded":
      return { ...evidence, ok: true, outcome };

    case "failed":
      return {
        ...evidence,
        ok: false,
        outcome,
        error: { name: "Error", phase: "run", message: options.message ?? "The run failed." },
      };

    case "cancelled":
      return { ...evidence, ok: false, outcome };
  }
}
