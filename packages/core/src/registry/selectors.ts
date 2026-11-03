import { SUPPORTED_RUNTIME_TUPLES, SUPPORTED_TARGETS } from "./tuples.ts";
import {
  databaseTargetId,
  type DatabaseTarget,
  type RuntimeReleaseLine,
  type SupportedRuntimeTuple,
  type RuntimeTupleQuery,
  type RuntimeTupleSelection,
} from "./types.ts";

const RELEASE_LINE_ORDER: readonly RuntimeReleaseLine[] = ["next", "legacy"];

function getTuplesForTarget(target: DatabaseTarget): readonly SupportedRuntimeTuple[] {
  const targetId = databaseTargetId(target);

  return SUPPORTED_RUNTIME_TUPLES.filter((tuple) => databaseTargetId(tuple.target) === targetId);
}

/** List every database target the runtime supports. */
export function listSupportedTargets(): readonly DatabaseTarget[] {
  return SUPPORTED_TARGETS;
}

/** List the supported runtime tuples of a target, or of every target when `target` is omitted. */
export function listSupportedTuples(target?: DatabaseTarget): readonly SupportedRuntimeTuple[] {
  return target === undefined ? SUPPORTED_RUNTIME_TUPLES : getTuplesForTarget(target);
}

/** Find the supported runtime tuple of a target, ORM and Kit version; undefined when they are not one. */
export function findSupportedTuple(query: RuntimeTupleQuery): SupportedRuntimeTuple | undefined {
  const targetId = databaseTargetId(query.target);

  return SUPPORTED_RUNTIME_TUPLES.find(
    (tuple) =>
      databaseTargetId(tuple.target) === targetId &&
      tuple.ormVersion === query.ormVersion &&
      tuple.kitVersion === query.kitVersion,
  );
}

function createUnsupportedTupleError(query: RuntimeTupleQuery): Error {
  return new Error(
    `Unsupported runtime tuple: ${databaseTargetId(query.target)}, drizzle-orm@${query.ormVersion}, drizzle-kit@${query.kitVersion}`,
  );
}

/**
 * Resolve a supported runtime tuple
 *
 * Throws when the target, ORM, and Kit versions are not a supported combination, such as an ORM and a Kit from
 * different pairs, which the version types alone allow.
 */
export function resolveSupportedTuple(selection: RuntimeTupleSelection): SupportedRuntimeTuple {
  const resolvedTuple = findSupportedTuple(selection);

  if (resolvedTuple === undefined) {
    throw createUnsupportedTupleError(selection);
  }

  return resolvedTuple;
}

/**
 * Check whether a target, ORM, and Kit version are a supported combination
 *
 * Narrows unchecked versions, such as a stored manifest's, to a selection `resolveSupportedTuple` accepts.
 */
export function isSupportedTuple<Query extends RuntimeTupleQuery>(
  query: Query,
): query is Query & RuntimeTupleSelection {
  return findSupportedTuple(query) !== undefined;
}

/**
 * Assert that a target, ORM, and Kit version are a supported combination
 *
 * `isSupportedTuple` for input that must be valid, such as a link being opened: throws the error
 * `resolveSupportedTuple` would.
 */
export function assertSupportedTuple<Query extends RuntimeTupleQuery>(
  query: Query,
): asserts query is Query & RuntimeTupleSelection {
  if (findSupportedTuple(query) === undefined) {
    throw createUnsupportedTupleError(query);
  }
}

/**
 * Get the recommended tuple of a target
 *
 * Throws when the catalog recommends none for the target.
 */
export function getRecommendedTuple(target: DatabaseTarget): SupportedRuntimeTuple {
  const recommendedTuple = getTuplesForTarget(target).find((tuple) => tuple.recommended);

  if (recommendedTuple === undefined) {
    throw new Error(`No recommended tuple for ${databaseTargetId(target)}`);
  }

  return recommendedTuple;
}

function parseVersion(version: string) {
  // Build metadata has no precedence, and only the first hyphen starts the pre-release.
  const [versionWithoutBuild = ""] = version.split("+", 1);
  const hyphenIndex = versionWithoutBuild.indexOf("-");
  const releaseVersion = hyphenIndex === -1 ? versionWithoutBuild : versionWithoutBuild.slice(0, hyphenIndex);

  return {
    core: releaseVersion.split(".").map(Number),
    preRelease: hyphenIndex === -1 ? undefined : versionWithoutBuild.slice(hyphenIndex + 1).split("."),
  };
}

function comparePreRelease(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];

    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === undefined ? -1 : 1;
    }

    const isLeftNumeric = /^\d+$/.test(leftPart);
    const isRightNumeric = /^\d+$/.test(rightPart);

    if (isLeftNumeric && isRightNumeric && Number(leftPart) !== Number(rightPart)) {
      return Number(leftPart) - Number(rightPart);
    }

    if (isLeftNumeric !== isRightNumeric) {
      return isLeftNumeric ? -1 : 1;
    }

    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }

  return 0;
}

/**
 * Compare two versions by semver precedence
 *
 * Returns a negative number when `left` is older, positive when newer, 0 when equal: 1.0.0 > 1.0.0-rc.10 >
 * 1.0.0-rc.9 > 0.45.4. Build metadata is ignored.
 */
export function compareVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);

  for (let index = 0; index < Math.max(leftVersion.core.length, rightVersion.core.length); index += 1) {
    const difference = (leftVersion.core[index] ?? 0) - (rightVersion.core[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  if (leftVersion.preRelease === undefined || rightVersion.preRelease === undefined) {
    if (leftVersion.preRelease === rightVersion.preRelease) {
      return 0;
    }

    return leftVersion.preRelease === undefined ? 1 : -1;
  }

  return comparePreRelease(leftVersion.preRelease, rightVersion.preRelease);
}

/** Get the release line of an ORM version: every 1.x build, pre-releases included, is Next. */
export function releaseLineOf(ormVersion: string): RuntimeReleaseLine {
  return compareVersions(ormVersion, "1.0.0-0") >= 0 ? "next" : "legacy";
}

/** Release pairs split for a picker: the newest per line, then the rest. */
export interface ReleasePairSelection {
  /** The newest pair of each release line, Next first. */
  newest: readonly SupportedRuntimeTuple[];
  /** Every other pair, newest first. */
  others: readonly SupportedRuntimeTuple[];
}

/**
 * Split release pairs for a picker
 *
 * Keeps the pairs of `target`, then returns the newest of each release line, Next first, and every other pair,
 * newest first.
 */
export function selectFromPairs(pairs: readonly SupportedRuntimeTuple[], target: DatabaseTarget): ReleasePairSelection {
  const targetId = databaseTargetId(target);
  const sortedPairs = pairs
    .filter((tuple) => databaseTargetId(tuple.target) === targetId)
    .toSorted((left, right) => compareVersions(right.ormVersion, left.ormVersion));
  const newestPairs = RELEASE_LINE_ORDER.flatMap((releaseLine) => {
    const newestPair = sortedPairs.find((tuple) => tuple.releaseLine === releaseLine);

    return newestPair === undefined ? [] : [newestPair];
  });

  return Object.freeze({
    newest: Object.freeze(newestPairs),
    others: Object.freeze(sortedPairs.filter((tuple) => !newestPairs.includes(tuple))),
  });
}
