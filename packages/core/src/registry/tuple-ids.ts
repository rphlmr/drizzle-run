import { databaseTargetId, type DatabaseTarget, type DatabaseTargetId } from "./types.ts";

/** The fields a tuple is selected by. */
export interface SelectableTuple<TupleId> {
  readonly id: TupleId;
  readonly kitVersion: string;
  readonly target: DatabaseTarget;
}

/**
 * Select the ids of the tuples on one Kit version or database target
 *
 * Compares each field exactly, never the id text: Kit `1.0.0` must not select a `1.0.0-rc.5` tuple. An omitted field
 * matches every tuple.
 */
export function selectTupleIds<TupleId>(
  tuples: readonly SelectableTuple<TupleId>[],
  { kitVersion, targetId }: { kitVersion?: string; targetId?: DatabaseTargetId },
): TupleId[] {
  return tuples
    .filter(
      (tuple) =>
        (kitVersion === undefined || tuple.kitVersion === kitVersion) &&
        (targetId === undefined || databaseTargetId(tuple.target) === targetId),
    )
    .map((tuple) => tuple.id);
}
