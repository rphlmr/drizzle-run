import { GUEST_FLAVORS, GUEST_IMAGES, RELEASE_PAIRS, type GuestFlavor } from "../releases/catalog.ts";
import type { RuntimeReleaseLine, SupportedRuntimeTuple } from "./types.ts";

export { GUEST_FLAVORS };
export type { GuestFlavor };

/** A catalogued guest composition: one release pair in one flavor. */
export interface GuestImage {
  id: string;
  releaseLine: RuntimeReleaseLine;
  ormVersion: string;
  kitVersion: string;
  guestFlavor: GuestFlavor;
}

/** The guest a run uses: its runtime tuple and the guest flavor its manifest asks for. */
export interface GuestSelection {
  tuple: SupportedRuntimeTuple;
  guestFlavor: GuestFlavor;
}

/**
 * Resolve the guest flavor of a manifest or a side-by-side side
 *
 * Reads its `guestFlavor` field; a manifest without one runs on `slim`.
 */
export function resolveGuestFlavor({ guestFlavor }: { readonly guestFlavor?: GuestFlavor }): GuestFlavor {
  return guestFlavor ?? "slim";
}

/**
 * Get a guest image id
 *
 * The slim image keeps the plain pair id, `orm-<version>__kit-<version>`; other flavors append `+<flavor>`.
 */
export function toGuestImageId({
  ormVersion,
  kitVersion,
  guestFlavor,
}: {
  ormVersion: string;
  kitVersion: string;
  guestFlavor: GuestFlavor;
}): string {
  const pairId = `orm-${ormVersion}__kit-${kitVersion}`;

  return guestFlavor === "slim" ? pairId : `${pairId}+${guestFlavor}`;
}

/** List every guest image the catalog ships, each release pair in each of its flavors. */
export function listGuestImages(): readonly GuestImage[] {
  return Object.values(RELEASE_PAIRS).flatMap(({ releaseLine, ormVersion, kitVersion, guestFlavors }) =>
    guestFlavors.map((guestFlavor) => ({
      id: toGuestImageId({ ormVersion, kitVersion, guestFlavor }),
      releaseLine,
      ormVersion,
      kitVersion,
      guestFlavor,
    })),
  );
}

/** Whether a tuple's release pair ships a guest in this flavor. */
export function hasGuestFlavor(tuple: SupportedRuntimeTuple, guestFlavor: GuestFlavor): boolean {
  return listGuestImages().some(
    (image) =>
      image.ormVersion === tuple.ormVersion &&
      image.kitVersion === tuple.kitVersion &&
      image.guestFlavor === guestFlavor,
  );
}

/**
 * Get the lock digest of a guest image
 *
 * The SHA-256 of the image's package lock, as the generated catalog records it, so a refresh of its companion
 * libraries changes it while its id stays. Returns `null` for an image the catalog does not ship.
 */
export function getGuestLockDigest(imageId: string): string | null {
  return Object.entries(GUEST_IMAGES).find(([id]) => id === imageId)?.[1].lockDigest ?? null;
}
