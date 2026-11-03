import {
  compareVersions,
  DIALECT_IDS,
  DIALECTS,
  GUEST_FLAVORS,
  hasGuestFlavor,
  listSupportedTuples,
  type Dialect,
  type GuestFlavor,
} from "@drizzle-run/core/catalog";

import type { CommunityTopic } from "./community-repository";

/**
 * Link preview images of shares
 *
 * Images are drawn at build time (scripts/build-og-images.ts), so the Worker spends no CPU on them. A share's image
 * names its Community topic and each version it runs, with its database and guest flavor: one, or two for side by
 * side, each on PostgreSQL or SQLite. Every combination of the catalog's databases, versions and flavors is drawn; a
 * share on a version or flavor the catalog no longer ships gets its topic's generic image.
 */
export interface ShareImageVariant {
  topic: CommunityTopic;
  runtime: OgRuntime | null;
}

/** One version a card names: its database, its ORM version, and "effect" when it runs on the Effect image. */
export interface OgSide {
  dialect: Dialect;
  ormVersion: string;
  guestFlavor: GuestFlavor;
}

/** What a card says a playground runs on. */
export interface OgRuntime {
  /**
   * PostgreSQL first, then oldest first, a plain side before its Effect twin: one side, or two for side by side.
   */
  sides: readonly [OgSide] | readonly [OgSide, OgSide];
}

const topicTitles = {
  playground: "A shared Drizzle playground",
  "bug-repros": "A Drizzle bug repro",
} satisfies Record<CommunityTopic, string>;
const topics = ["playground", "bug-repros"] as const satisfies readonly CommunityTopic[];

/** A side as an image path names it: "1.0.0-rc.5", or "1.0.0-rc.5+effect" on the Effect image. */
function toSidePathName({ ormVersion, guestFlavor }: OgSide): string {
  return guestFlavor === "slim" ? ormVersion : `${ormVersion}+${guestFlavor}`;
}

/** A side as a card names it: "1.0.0-rc.5", or "1.0.0-rc.5 + Effect" on the Effect image. */
export function toOgSideName({ ormVersion, guestFlavor }: OgSide): string {
  return guestFlavor === "effect" ? `${ormVersion} + Effect` : ormVersion;
}

/** The databases a runtime's sides run, in side order and without repeats: one, or two for sides on both. */
export function listOgDialects(runtime: OgRuntime): Dialect[] {
  return [...new Set(runtime.sides.map((side) => side.dialect))];
}

/**
 * The image path of a share variant, under the site root
 *
 * Its databases, then its versions: `/og/shares/playground/postgresql/0.45.4-vs-1.0.0-rc.5.png` for one database, and
 * `/og/shares/playground/postgresql-vs-sqlite/1.0.0-rc.5-vs-1.0.0-rc.5.png` for sides on both.
 */
export function toShareImagePath({ topic, runtime }: ShareImageVariant): string {
  if (runtime === null) {
    return `/og/shares/${topic}.png`;
  }

  return `/og/shares/${topic}/${listOgDialects(runtime).join("-vs-")}/${runtime.sides.map(toSidePathName).join("-vs-")}.png`;
}

/**
 * What a share variant's image shows, for `og:image:alt`
 *
 * Such as "A Drizzle bug repro, PostgreSQL 0.45.4 vs 1.0.0-rc.5", or "A shared Drizzle playground, PostgreSQL
 * 1.0.0-rc.5 vs SQLite 1.0.0-rc.5" for sides on two databases.
 */
export function describeShareImage({ topic, runtime }: ShareImageVariant): string {
  if (runtime === null) {
    return topicTitles[topic];
  }

  if (listOgDialects(runtime).length === 1) {
    return `${topicTitles[topic]}, ${DIALECTS[runtime.sides[0].dialect].label} ${runtime.sides.map(toOgSideName).join(" vs ")}`;
  }

  return `${topicTitles[topic]}, ${runtime.sides.map((side) => `${DIALECTS[side.dialect].label} ${toOgSideName(side)}`).join(" vs ")}`;
}

/** PostgreSQL first, then the oldest version, and on one version the plain side before the Effect one. */
function compareSides(left: OgSide, right: OgSide): number {
  return (
    DIALECT_IDS.indexOf(left.dialect) - DIALECT_IDS.indexOf(right.dialect) ||
    compareVersions(left.ormVersion, right.ormVersion) ||
    GUEST_FLAVORS.indexOf(left.guestFlavor) - GUEST_FLAVORS.indexOf(right.guestFlavor)
  );
}

/** Every side the catalog runs: each database's versions in each flavor they ship, in `compareSides` order. */
function listOgSides(): OgSide[] {
  return DIALECT_IDS.flatMap((dialect) =>
    listSupportedTuples({ dialect }).flatMap((tuple) =>
      GUEST_FLAVORS.filter((guestFlavor) => hasGuestFlavor(tuple, guestFlavor)).map((guestFlavor) => ({
        dialect,
        ormVersion: tuple.ormVersion,
        guestFlavor,
      })),
    ),
  ).toSorted(compareSides);
}

/**
 * Resolve a share's image variant
 *
 * The sides are put in `OgRuntime` order; a database, version or flavor outside the catalog gives the generic variant
 * of the topic.
 */
export function resolveShareImageVariant(topic: CommunityTopic, sides: readonly OgSide[]): ShareImageVariant {
  const supported = listOgSides();
  const sorted = sides.toSorted(compareSides);
  const [first, second] = sorted;
  const isSupported = (side: OgSide) =>
    supported.some(
      (item) =>
        item.dialect === side.dialect && item.ormVersion === side.ormVersion && item.guestFlavor === side.guestFlavor,
    );

  if (first === undefined || sorted.length > 2 || !sorted.every(isSupported)) {
    return { topic, runtime: null };
  }

  return { topic, runtime: { sides: second === undefined ? [first] : [first, second] } };
}

/** Every share variant the build draws: each topic's generic image, and each side and pair of sides. */
export function listShareImageVariants(): ShareImageVariant[] {
  const variants: ShareImageVariant[] = topics.map((topic) => ({ topic, runtime: null }));
  const sides = listOgSides();

  for (const topic of topics) {
    for (const [index, first] of sides.entries()) {
      variants.push({ topic, runtime: { sides: [first] } });

      for (const second of sides.slice(index)) {
        variants.push({ topic, runtime: { sides: [first, second] } });
      }
    }
  }

  return variants;
}
