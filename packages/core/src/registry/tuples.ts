import {
  DATABASE_TARGETS,
  RELEASE_PAIRS,
  type RuntimeKitVersion,
  type RuntimeOrmVersion,
} from "../releases/catalog.ts";
import type {
  DatabaseTarget,
  DatabaseTargetId,
  RuntimeReleaseLine,
  SupportedRuntimeTuple,
  RuntimeTupleId,
} from "./types.ts";

const TARGETS = DATABASE_TARGETS satisfies Record<DatabaseTargetId, DatabaseTarget>;
const RUNTIME_TUPLE_ID_PATTERN = /^[a-z-]+__orm-[^_]+__kit-[^_]+$/;

function createRuntimeTuple({
  targetId,
  releaseLine,
  ormVersion,
  kitVersion,
  recommended,
}: {
  targetId: DatabaseTargetId;
  releaseLine: RuntimeReleaseLine;
  ormVersion: RuntimeOrmVersion;
  kitVersion: RuntimeKitVersion;
  recommended: boolean;
}): SupportedRuntimeTuple {
  const id = `${targetId}__orm-${ormVersion}__kit-${kitVersion}`;

  if (!isRuntimeTupleId(id)) {
    throw new TypeError(`Expected a runtime tuple id like <target>__orm-<version>__kit-<version>, but got '${id}'`);
  }

  return {
    id,
    target: TARGETS[targetId],
    releaseLine,
    ormVersion,
    kitVersion,
    recommended,
  };
}

function isRuntimeTupleId(id: string): id is RuntimeTupleId {
  return RUNTIME_TUPLE_ID_PATTERN.test(id);
}

function isDatabaseTargetId(id: string): id is DatabaseTargetId {
  return Object.hasOwn(TARGETS, id);
}

/** Every database target the runtime supports. */
export const SUPPORTED_TARGETS = Object.freeze(Object.values(TARGETS)) as readonly DatabaseTarget[];

/** Every runtime tuple: each database target crossed with each release pair. */
export const SUPPORTED_RUNTIME_TUPLES = Object.freeze(
  Object.keys(TARGETS)
    .filter(isDatabaseTargetId)
    .flatMap((targetId) =>
      Object.values(RELEASE_PAIRS).map(({ releaseLine, ormVersion, kitVersion, recommended }) =>
        createRuntimeTuple({ targetId, releaseLine, ormVersion, kitVersion, recommended }),
      ),
    ),
);
