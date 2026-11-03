import * as z from "zod/mini";

import { GUEST_FLAVORS, hasGuestFlavor, type GuestFlavor } from "../registry/guest-images.ts";
import { isSupportedTuple, listSupportedTuples, releaseLineOf } from "../registry/selectors.ts";
import type { RuntimeReleaseLine, SupportedRuntimeTuple } from "../registry/types.ts";
import { DataRecordSchema } from "../shared/schema.ts";
import { assertImportsAvailable } from "./imports.ts";
import { RunManifestTargetSchema } from "./schema.ts";
import type { RunManifest, RunManifestTarget } from "./types.ts";
import { parseRunManifest, safeParseRunManifest } from "./validation.ts";

/** An ORM/Kit pair a manifest was written for that the catalog no longer ships. */
export interface RetiredPair {
  target: RunManifestTarget;
  releaseLine: RuntimeReleaseLine;
  ormVersion: string;
  kitVersion: string;
}

const ExactVersionSchema = z.string().check(z.regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/));

/**
 * The part of a manifest that names its pair
 *
 * A known target and exact ORM and Kit versions; every other field is left for the run manifest to check.
 */
export const PinnedPairSchema = z.pipe(
  DataRecordSchema,
  z.looseObject({
    target: RunManifestTargetSchema,
    dependencies: z.pipe(
      DataRecordSchema,
      z.looseObject({ "drizzle-orm": ExactVersionSchema, "drizzle-kit": ExactVersionSchema }),
    ),
  }),
);

/**
 * Resolve the flavor a manifest moves to
 *
 * An explicit flavor must ship with the pair. Without one, the manifest keeps its own flavor when the pair ships it
 * and falls back to `slim` otherwise, so moving an Effect project to Legacy makes it slim.
 */
function resolveMoveFlavor(
  manifest: Record<string, unknown>,
  tuple: SupportedRuntimeTuple,
  guestFlavor: GuestFlavor | undefined,
): GuestFlavor {
  if (guestFlavor !== undefined) {
    if (!hasGuestFlavor(tuple, guestFlavor)) {
      throw new Error(`Drizzle ORM ${tuple.ormVersion} has no ${guestFlavor} guest; choose a release that ships one.`);
    }

    return guestFlavor;
  }

  const requestedFlavor = GUEST_FLAVORS.find((flavor) => flavor === manifest.guestFlavor) ?? "slim";

  return hasGuestFlavor(tuple, requestedFlavor) ? requestedFlavor : "slim";
}

/**
 * The manifest on the pair's database, with its dependencies set to the pair and its guest flavor set
 *
 * Companion libraries are never pinned, so the pair's ORM and Kit versions are the whole dependency record.
 */
export function pinManifestToPair(
  manifest: Record<string, unknown>,
  tuple: SupportedRuntimeTuple,
  requestedFlavor?: GuestFlavor,
): Record<string, unknown> {
  const guestFlavor = resolveMoveFlavor(manifest, tuple, requestedFlavor);

  return {
    ...manifest,
    target: { dialect: tuple.target.dialect },
    dependencies: { "drizzle-orm": tuple.ormVersion, "drizzle-kit": tuple.kitVersion },
    guestFlavor,
  };
}

/**
 * Move a manifest to a supported pair, on that pair's database
 *
 * The files stay as they are: a schema written for another database keeps its imports, which the new database's
 * compiler then reports. `guestFlavor` sets the guest flavor; without it the manifest keeps its flavor where the pair ships it. Throws when
 * the pair has no guest in that flavor, `RunManifestValidationError` when the result is still invalid, and an error
 * naming them, such as "drizzle-zod is not available with orm 1.0.0-rc.5 · kit 1.0.0-rc.5. Pick another release.",
 * when the files import a package the pair's guest does not ship.
 */
export function moveManifestToPair(
  manifest: unknown,
  tuple: SupportedRuntimeTuple,
  guestFlavor?: GuestFlavor,
): RunManifest {
  const record = DataRecordSchema.safeParse(manifest);
  const moved = parseRunManifest(record.success ? pinManifestToPair(record.data, tuple, guestFlavor) : manifest);

  assertImportsAvailable(moved);

  return moved;
}

/**
 * Find the removed pair of a manifest
 *
 * Only reports a manifest that needs nothing but a supported pair to be valid.
 * Undefined for supported manifests and for manifests with any other problem.
 */
export function findRetiredPair(manifest: unknown): RetiredPair | undefined {
  const pinned = PinnedPairSchema.safeParse(manifest);

  if (!pinned.success) {
    return undefined;
  }

  const { target, dependencies } = pinned.data;
  const ormVersion = dependencies["drizzle-orm"];
  const kitVersion = dependencies["drizzle-kit"];

  if (isSupportedTuple({ target, ormVersion, kitVersion })) {
    return undefined;
  }

  const isMovable = listSupportedTuples(target).some(
    (tuple) => safeParseRunManifest(pinManifestToPair(pinned.data, tuple)).success,
  );

  if (!isMovable) {
    return undefined;
  }

  return {
    target,
    releaseLine: releaseLineOf(ormVersion),
    ormVersion,
    kitVersion,
  };
}

/**
 * Get the pair a retired pair is updated to in place
 *
 * Legacy keeps a single pair that fix releases update in place, so an older
 * Legacy version has that pair as its successor. Next ships a new pair per
 * release: a removed Next pair has no successor and needs a choice.
 */
export function inPlaceSuccessor(pair: RetiredPair): SupportedRuntimeTuple | undefined {
  const legacyTuples = listSupportedTuples(pair.target).filter((tuple) => tuple.releaseLine === "legacy");

  return pair.releaseLine === "legacy" && legacyTuples.length === 1 ? legacyTuples[0] : undefined;
}

/**
 * Follow an in-place Legacy release
 *
 * Moves a manifest on an older Legacy version to the current Legacy pair; anything else is returned as is.
 */
export function followInPlaceRelease(manifest: unknown): unknown {
  const retiredPair = findRetiredPair(manifest);
  const successor = retiredPair && inPlaceSuccessor(retiredPair);

  const record = DataRecordSchema.safeParse(manifest);

  if (successor === undefined || !record.success) {
    return manifest;
  }

  const result = safeParseRunManifest(pinManifestToPair(record.data, successor));

  return result.success ? result.data : manifest;
}
