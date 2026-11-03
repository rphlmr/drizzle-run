import type { RunManifestTarget } from "../manifest/types.ts";
import { GUEST_IMAGES, HOST_ENGINES, ORM_EXPORT_INVENTORY, RELEASE_PAIRS } from "./guest-catalog.generated.ts";

/** Database targets keyed by id, with the dialect each one runs. */
export const DATABASE_TARGETS = {
  "postgresql-pglite": { dialect: "postgresql" },
  "sqlite-wasm": { dialect: "sqlite" },
} as const satisfies Record<string, RunManifestTarget>;

/**
 * Guest image flavors
 *
 * Every pair ships a `slim` guest. A larger flavor adds packages only some projects use, so their
 * parse cost never reaches the runs that do not: `effect` adds Effect and its SQL clients.
 */
export const GUEST_FLAVORS = ["slim", "effect"] as const;

export type GuestFlavor = (typeof GUEST_FLAVORS)[number];

/**
 * The Effect packages of the `effect` guest flavor
 *
 * Their versions come from the effect guests. drizzle-orm 1.0.0-rc.5 is the first release built against Effect 4.0
 * stable, so the pin moves within 4.x and a pair on an earlier release could not share it.
 */
export const EFFECT_PACKAGE_NAMES = ["effect", "@effect/sql-pg", "@effect/sql-libsql"] as const;

export { GUEST_IMAGES, HOST_ENGINES, ORM_EXPORT_INVENTORY, RELEASE_PAIRS };
export type { OrmExportInventory } from "./guest-catalog.generated.ts";

type GuestImage = (typeof GUEST_IMAGES)[GuestImageId];

/** Every guest image id: one per release pair and flavor. */
export type GuestImageId = keyof typeof GUEST_IMAGES;

/** The versions guest images pin for a package, as a union of literals; `never` when no image pins it. */
export type GuestPackageVersion<PackageName extends string, Image = GuestImage> = Image extends {
  readonly packages: { readonly [Name in PackageName]: infer Version };
}
  ? Version
  : never;

export type DatabaseTargetId = keyof typeof DATABASE_TARGETS;
export type OrmVersion = GuestPackageVersion<"drizzle-orm">;
export type RuntimeOrmVersion = (typeof RELEASE_PAIRS)[keyof typeof RELEASE_PAIRS]["ormVersion"];
export type RuntimeKitVersion = (typeof RELEASE_PAIRS)[keyof typeof RELEASE_PAIRS]["kitVersion"];
export type KitVersion = GuestPackageVersion<"drizzle-kit">;
export type SeedVersion = GuestPackageVersion<"drizzle-seed">;
export type ReleasePairId = keyof typeof RELEASE_PAIRS;
export type ReleaseLine = (typeof RELEASE_PAIRS)[ReleasePairId]["releaseLine"];

const guestImageList: readonly GuestImage[] = Object.values(GUEST_IMAGES);

function toUniqueSorted<Version extends string>(versions: readonly Version[]): readonly Version[] {
  return Object.freeze([...new Set(versions)].toSorted());
}

/** Bundled `drizzle-kit` versions, sorted. */
export const KIT_VERSIONS = toUniqueSorted(guestImageList.map((image) => image.packages["drizzle-kit"]));

/** The versions the guest images of one release line pin for a package, as a union of literals. */
export type LinePackageVersion<Line extends ReleaseLine, PackageName extends string> = GuestPackageVersion<
  PackageName,
  Extract<GuestImage, { readonly releaseLine: Line }>
>;

/**
 * List the versions the guest images of one release line pin for a package
 *
 * Returns them in image order without repeats. Throws when no image of the line pins the package, because a schema
 * built from the list would then admit nothing.
 */
export function listLinePackageVersions<Line extends ReleaseLine, PackageName extends string>(
  releaseLine: Line,
  packageName: PackageName,
): readonly [LinePackageVersion<Line, PackageName>, ...LinePackageVersion<Line, PackageName>[]] {
  const versions = new Set<LinePackageVersion<Line, PackageName>>();

  for (const image of guestImageList) {
    if (isLineImagePinning(image, releaseLine, packageName)) {
      versions.add(image.packages[packageName]);
    }
  }

  const [first, ...rest] = versions;

  if (first === undefined) {
    throw new Error(`Expected a ${releaseLine} guest image to pin ${packageName}, but none does`);
  }

  return [first, ...rest];
}

function isLineImagePinning<Line extends ReleaseLine, PackageName extends string>(
  image: GuestImage,
  releaseLine: Line,
  packageName: PackageName,
): image is Extract<GuestImage, { readonly releaseLine: Line }> & {
  readonly packages: { readonly [Name in PackageName]: LinePackageVersion<Line, PackageName> };
} {
  return image.releaseLine === releaseLine && Object.hasOwn(image.packages, packageName);
}

/** Guest images keyed by id, with the packages each pins: the generated `GUEST_IMAGES`, or test images. */
export type GuestImagePins = Readonly<Record<string, { readonly packages: Readonly<Record<string, string>> }>>;

/**
 * Get the version a guest image pins for a package
 *
 * Reads `GUEST_IMAGES` unless `guestImages` is given. Returns `null` when the image is unknown or does not ship the
 * package.
 */
export function getGuestPackageVersion({
  imageId,
  packageName,
  guestImages = GUEST_IMAGES,
}: {
  imageId: string;
  packageName: string;
  guestImages?: GuestImagePins;
}): string | null {
  const image = Object.entries(guestImages).find(([id]) => id === imageId)?.[1];

  if (image === undefined) {
    return null;
  }

  return Object.entries(image.packages).find(([name]) => name === packageName)?.[1] ?? null;
}
