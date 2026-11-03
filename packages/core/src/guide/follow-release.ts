import { isEqual } from "es-toolkit";

import { followInPlaceRelease, inPlaceSuccessor, PinnedPairSchema } from "../manifest/retired-pair.ts";
import { followPairInPlaceRelease, isPairManifestLike } from "../pair/validation.ts";
import { isSupportedTuple, listSupportedTargets, releaseLineOf } from "../registry/selectors.ts";
import { DataRecordSchema } from "../shared/schema.ts";

type RunDependencyPins = { "drizzle-orm": string; "drizzle-kit": string };

/**
 * The current Legacy pins for a split side's older Legacy pins
 *
 * A side without its own database takes the project's at that step, which only a replay knows, so every database is
 * asked: the pins move only when each one that ships the release moves them to the same pair.
 */
function followSplitSideDependencies(side: Record<string, unknown>): RunDependencyPins | undefined {
  const targets =
    side.target === undefined ? listSupportedTargets().map(({ dialect }) => ({ dialect })) : [side.target];
  const successors = targets.flatMap((target) => {
    const pinned = PinnedPairSchema.safeParse({ target, dependencies: side.dependencies });

    if (!pinned.success) {
      return [];
    }

    const ormVersion = pinned.data.dependencies["drizzle-orm"];
    const kitVersion = pinned.data.dependencies["drizzle-kit"];
    const successor = isSupportedTuple({ target: pinned.data.target, ormVersion, kitVersion })
      ? undefined
      : inPlaceSuccessor({
          target: pinned.data.target,
          releaseLine: releaseLineOf(ormVersion),
          ormVersion,
          kitVersion,
        });

    return successor === undefined
      ? []
      : [{ "drizzle-orm": successor.ormVersion, "drizzle-kit": successor.kitVersion }];
  });
  const [first] = successors;

  if (first === undefined || successors.length !== targets.length) {
    return undefined;
  }

  return successors.every((pins) => isEqual(pins, first)) ? first : undefined;
}

function followSplit(split: unknown): unknown {
  const record = DataRecordSchema.safeParse(split);

  if (!record.success || !Array.isArray(record.data.sides)) {
    return split;
  }

  const sides = record.data.sides.map((side: unknown) => {
    const sideRecord = DataRecordSchema.safeParse(side);

    if (!sideRecord.success || sideRecord.data.dependencies === undefined) {
      return side;
    }

    const dependencies = followSplitSideDependencies(sideRecord.data);

    return dependencies === undefined ? side : { ...sideRecord.data, dependencies };
  });

  return { ...record.data, sides };
}

/**
 * Follow an in-place Legacy release in a guide
 *
 * Moves the guide's project, and each split side pinned to an older Legacy release, to the current Legacy pair, so a
 * guide written before a Legacy fix release still opens. A Next release has no in-place successor, and anything that
 * is not a guide is returned as is for validation to report.
 */
export function followGuideInPlaceRelease(input: unknown): unknown {
  const guide = DataRecordSchema.safeParse(input);

  if (!guide.success) {
    return input;
  }

  const { project, steps } = guide.data;
  const followed = { ...guide.data };

  if (project !== undefined) {
    followed.project = isPairManifestLike(project) ? followPairInPlaceRelease(project) : followInPlaceRelease(project);
  }

  if (Array.isArray(steps)) {
    followed.steps = steps.map((step: unknown) => {
      const stepRecord = DataRecordSchema.safeParse(step);

      return stepRecord.success && stepRecord.data.split !== undefined
        ? { ...stepRecord.data, split: followSplit(stepRecord.data.split) }
        : step;
    });
  }

  return followed;
}
