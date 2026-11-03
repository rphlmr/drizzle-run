import type { RunManifest } from "@drizzle-run/core/manifest";
import { listGuestImages, toGuestImageId } from "@drizzle-run/core/registry";
import * as z from "zod/mini";

export const GuestSelectionSchema = z.object({
  imageId: z.string(),
  dialect: z.enum(["postgresql", "sqlite"]),
});
export type GuestSelection = z.output<typeof GuestSelectionSchema>;

export const defaultGuestSelection = {
  imageId: "orm-0.45.4__kit-0.31.11",
  dialect: "postgresql",
} satisfies GuestSelection;

/** Resolve only catalogued, pinned images. The dialect also identifies the dependency snapshot. */
export function selectGuest(manifest: RunManifest): GuestSelection {
  const imageId = toGuestImageId({
    ormVersion: manifest.dependencies["drizzle-orm"],
    kitVersion: manifest.dependencies["drizzle-kit"],
    guestFlavor: manifest.guestFlavor ?? "slim",
  });

  if (!listGuestImages().some((image) => image.id === imageId)) {
    throw new Error(`No QuickJS guest is registered for ${imageId}`);
  }

  return { imageId, dialect: manifest.target.dialect };
}

export function guestAssetPrefix({ imageId, dialect }: GuestSelection): string {
  return `${imageId}/${dialect}`;
}
