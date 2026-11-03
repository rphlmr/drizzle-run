import { RunManifestValidationError } from "../manifest/validation.ts";
import { resolveGuestFlavor, type GuestFlavor } from "../registry/guest-images.ts";
import { DIALECTS, type Dialect } from "../releases/dialects.ts";
import type { PairManifest, PairSide } from "./types.ts";

/**
 * Get the name a side goes by
 *
 * The minor line of a stable release ("0.45") or the pre-release tag of a release candidate ("rc.5").
 */
export function pairSideLabel(ormVersion: string): string {
  const [releaseVersion = ormVersion, preRelease] = ormVersion.split("-", 2);

  if (preRelease !== undefined) {
    return preRelease;
  }

  return releaseVersion.split(".").slice(0, 2).join(".");
}

/**
 * Get the name a side goes by, with its flavor
 *
 * `pairSideLabel` plus " + Effect" on the Effect image, so rc.5 and rc.5 with Effect read apart side by side.
 */
export function pairSideName({ ormVersion, guestFlavor }: { ormVersion: string; guestFlavor: GuestFlavor }): string {
  const label = pairSideLabel(ormVersion);

  return guestFlavor === "effect" ? `${label} + Effect` : label;
}

/** What a side's label is made of: its name when it has one, else its release and flavor, then its database. */
export interface PairSideLabelSource {
  name?: string | undefined;
  ormVersion: string;
  guestFlavor: GuestFlavor;
  dialect: Dialect;
}

/**
 * Get what two sides are called, in side order, before or after they form a pair
 *
 * As `pairSideLabels`, for sides that are still being moved, such as one whose new release has no guest in a flavor.
 */
export function toPairSideLabels(
  sides: readonly [PairSideLabelSource, PairSideLabelSource],
): readonly [string, string] {
  const [first, second] = sides;
  const firstLabel = first.name ?? pairSideName(first);
  const secondLabel = second.name ?? pairSideName(second);

  if (firstLabel !== secondLabel) {
    return [firstLabel, secondLabel];
  }

  return first.dialect === second.dialect
    ? [`${firstLabel} (1)`, `${secondLabel} (2)`]
    : [
        `${firstLabel} (${DIALECTS[first.dialect].shortName})`,
        `${secondLabel} (${DIALECTS[second.dialect].shortName})`,
      ];
}

/**
 * Get what each side is called, in side order
 *
 * A side's name, or its release as `pairSideName` gives it. When both read the same, they end in their database,
 * " (Postgres)" and " (SQLite)", or on one database in " (1)" and " (2)".
 */
export function pairSideLabels(manifest: PairManifest): readonly [string, string] {
  const [firstSide, secondSide] = manifest.sides;

  return toPairSideLabels([toPairSideLabelSource(firstSide), toPairSideLabelSource(secondSide)]);
}

/** What a side of a pair is called, before `toPairSideLabels` tells it apart from the other. */
export function toPairSideLabelSource(side: PairSide): PairSideLabelSource {
  return {
    name: side.name,
    ormVersion: side.dependencies["drizzle-orm"],
    guestFlavor: resolveGuestFlavor(side),
    dialect: side.target.dialect,
  };
}

/**
 * Name the side an error is about, as "rc.5 (2): ..."
 *
 * A `RunManifestValidationError` is rethrown as it is, so a caller can still list its issues; any other error is
 * rethrown with the side's label first and the original as its `cause`.
 */
export function throwWithSideLabel(label: string, cause: unknown): never {
  if (cause instanceof RunManifestValidationError) {
    throw cause;
  }

  const message = cause instanceof Error ? cause.message : String(cause);

  throw new Error(`${label}: ${message}`, { cause });
}
