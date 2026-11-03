import {
  compareVersions,
  hasGuestFlavor,
  isSupportedTuple,
  listCompanionLibraries,
  listSupportedTuples,
  resolveGuestFlavor,
  releaseLineOf,
  resolveSupportedTuple,
  selectFromPairs,
  type CompanionLibrary,
  type DatabaseTarget,
  type GuestFlavor,
  type RuntimeReleaseLine,
  type RuntimeTupleId,
  type RuntimeTupleSelection,
  type SupportedRuntimeTuple,
} from "@drizzle-run/core/catalog";
import { describeUnavailableImports, findUnavailableImports } from "@drizzle-run/core/manifest";

/**
 * A release pair and the manifest's `guestFlavor` selection.
 */
export interface ReleaseChoice {
  tupleId: RuntimeTupleId;
  guestFlavor: GuestFlavor;
}

/** A project's release pair and guest flavor, read from its manifest. */
export interface ReleaseCurrent {
  ormVersion: string;
  kitVersion: string;
  guestFlavor: GuestFlavor;
}

/** The Effect row's badge, and the words its spoken names add. */
export const EFFECT_BADGE_TEXT = "+ Effect 4";

/** A Drizzle ORM and Kit pair offered in the release controls, plain or with Effect. */
export interface ReleaseOption extends ReleaseChoice {
  line: RuntimeReleaseLine;
  ormVersion: RuntimeTupleSelection["ormVersion"];
  kitVersion: RuntimeTupleSelection["kitVersion"];
  /** Newest pair of its line. */
  newest: boolean;
  /** Carries the single Newest badge: the newest pair of the first line shown. */
  badge: boolean;
}

/** A project's pair that the catalog no longer offers. */
export interface UnavailableRelease {
  unavailable: true;
  ormVersion: string;
  kitVersion: string;
  suggested: ReleaseOption;
}

/** The release lines to offer, and the project's current pair, offered or not. */
export interface ReleaseOptions {
  /** The newest pair of each line, Next first, each followed by its Effect option when the pair ships one. */
  lines: ReleaseOption[];
  /** Every other pair, newest first, with its Effect option likewise. */
  others: ReleaseOption[];
  current: ReleaseOption | UnavailableRelease;
}

/** The release line of a pair: Legacy, RC, or Latest. */
export type ReleaseLabel = "Legacy" | "RC" | "Latest";

/** An ORM and Kit version pair as one line of text. */
export function formatPairText(ormVersion: string, kitVersion: string) {
  return `orm ${ormVersion} · kit ${kitVersion}`;
}

/**
 * A pair's name in the UI, read from its ORM version rather than core's
 * release line: Legacy is 0.x, RC a 1.x pre-release, Latest a stable 1.x.
 */
export function getReleaseLabel(ormVersion: string): ReleaseLabel {
  if (releaseLineOf(ormVersion) === "legacy") {
    return "Legacy";
  }

  return ormVersion.includes("-") ? "RC" : "Latest";
}

/** Read a manifest's pair from its dependency pins and its flavor from its `guestFlavor`. */
export function getReleaseCurrent(manifest: {
  dependencies: { "drizzle-orm": string; "drizzle-kit": string };
  guestFlavor?: GuestFlavor;
}): ReleaseCurrent {
  return {
    ormVersion: manifest.dependencies["drizzle-orm"],
    kitVersion: manifest.dependencies["drizzle-kit"],
    guestFlavor: resolveGuestFlavor(manifest),
  };
}

/** A choice's key: its tuple id, with `+effect` for the Effect flavor. */
export function toReleaseChoiceKey({ tupleId, guestFlavor }: ReleaseChoice): string {
  return guestFlavor === "slim" ? tupleId : `${tupleId}+${guestFlavor}`;
}

/** Whether the current pair is missing from the catalog. */
export function isUnavailableRelease(current: ReleaseOptions["current"]): current is UnavailableRelease {
  return "unavailable" in current;
}

/** Status bar trigger text, and its accessible name, which says "unavailable" in words rather than by color. */
export function getReleaseTriggerLabel(current: ReleaseOptions["current"]): { text: string; accessibleName: string } {
  const pair = `orm ${current.ormVersion} · kit ${current.kitVersion}`;

  if (isUnavailableRelease(current)) {
    return { text: `${pair} · Unavailable`, accessibleName: `Drizzle version: ${pair}, unavailable` };
  }

  if (current.guestFlavor === "effect") {
    return { text: `${pair} + Effect`, accessibleName: `Drizzle version: ${pair}, with Effect 4` };
  }

  return { text: pair, accessibleName: `Drizzle version: ${pair}` };
}

/** A release radio's name: the card's line, badge, and pair, as words rather than run-together spans. */
export function getReleaseChoiceName(option: ReleaseOption): string {
  const badge = option.badge ? ", newest" : "";
  const effect = option.guestFlavor === "effect" ? ", with Effect 4" : "";

  return `${getReleaseLabel(option.ormVersion)}${badge}, orm ${option.ormVersion} · kit ${option.kitVersion}${effect}`;
}

/**
 * The pair closest to a missing one: the oldest newer pair, else the newest
 * older one. Removed pairs are usually the oldest, so this is the nearest API.
 */
function findClosestPair(options: readonly ReleaseOption[], ormVersion: string): ReleaseOption | undefined {
  const sorted = options.toSorted((left, right) => compareVersions(left.ormVersion, right.ormVersion));

  return sorted.find((item) => compareVersions(item.ormVersion, ormVersion) > 0) ?? sorted.at(-1);
}

/**
 * The pair a new project starts on: the newest of the `next` line (RC, or Latest once a stable 1.x ships),
 * else the first line shown. Official examples and guides run on that line too.
 */
export function getNewProjectRelease(options: Pick<ReleaseOptions, "lines">): ReleaseOption | undefined {
  return options.lines.find((option) => option.line === "next") ?? options.lines[0];
}

/**
 * Splits the catalog's pairs for a database into the newest of each line and the rest, each pair followed by its
 * Effect option when it ships an effect guest, and resolves the project's pair and flavor. A pair the catalog no
 * longer has suggests the closest plain pair of its line; throws when the catalog has none.
 */
export function buildReleaseOptions(
  target: DatabaseTarget,
  current: Pick<ReleaseCurrent, "ormVersion" | "kitVersion"> & { guestFlavor?: GuestFlavor },
  pairs: readonly SupportedRuntimeTuple[] = listSupportedTuples(target),
): ReleaseOptions {
  const selection = selectFromPairs(pairs, target);
  const toOptions = (tuple: SupportedRuntimeTuple, newest: boolean): ReleaseOption[] => {
    const plain: ReleaseOption = {
      tupleId: tuple.id,
      guestFlavor: "slim",
      line: tuple.releaseLine,
      ormVersion: tuple.ormVersion,
      kitVersion: tuple.kitVersion,
      newest,
      badge: newest && tuple === selection.newest[0],
    };

    return hasGuestFlavor(tuple, "effect") ? [plain, { ...plain, guestFlavor: "effect", badge: false }] : [plain];
  };
  const lines = selection.newest.flatMap((tuple) => toOptions(tuple, true));
  const others = selection.others.flatMap((tuple) => toOptions(tuple, false));
  const all = [...lines, ...others];
  const currentFlavor = current.guestFlavor ?? "slim";
  const known = all.find(
    (item) =>
      item.ormVersion === current.ormVersion &&
      item.kitVersion === current.kitVersion &&
      item.guestFlavor === currentFlavor,
  );

  if (known) {
    return { lines, others, current: known };
  }

  const plainPairs = all.filter((item) => item.guestFlavor === "slim");
  const sameLine = plainPairs.filter((item) => item.line === releaseLineOf(current.ormVersion));
  const suggested = findClosestPair(sameLine.length > 0 ? sameLine : plainPairs, current.ormVersion);

  if (!suggested) {
    throw new Error("The release catalog has no pair for this database.");
  }

  return {
    lines,
    others,
    current: { unavailable: true, ormVersion: current.ormVersion, kitVersion: current.kitVersion, suggested },
  };
}

/**
 * List the libraries a Drizzle version ships besides Drizzle, such as zod or effect
 *
 * Empty for a pair Drizzle Run no longer ships, which has no guest to read.
 */
export function listReleaseLibraries(target: DatabaseTarget, current: ReleaseCurrent): readonly CompanionLibrary[] {
  const selection = { target, ormVersion: current.ormVersion, kitVersion: current.kitVersion };

  if (!isSupportedTuple(selection)) {
    return [];
  }

  return listCompanionLibraries({ tuple: resolveSupportedTuple(selection), guestFlavor: current.guestFlavor });
}

/**
 * Describe why a release cannot run a project's imports
 *
 * Such as "drizzle-zod is not available with orm 1.0.0-rc.5 · kit 1.0.0-rc.5. Pick another release." Undefined when
 * the release's guest serves every import, so the pickers can offer it.
 */
export function describeBlockedRelease(
  tuple: SupportedRuntimeTuple,
  guestFlavor: GuestFlavor,
  imports: readonly string[],
): string | undefined {
  const guest = { tuple, guestFlavor };
  const unavailable = findUnavailableImports(imports, guest);

  return unavailable.length === 0 ? undefined : describeUnavailableImports(unavailable, guest);
}
