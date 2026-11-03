/** A pinned guest installation returned by the existing guest installer. */
export interface GuestInstall {
  imageId: string;
  installKey: string;
  directory: string;
  cached: boolean;
}

/** Install selected guest locks into the shared build cache, verifying their dependency pins. */
export function installGuests(
  imageIds?: readonly string[],
  options?: { variant?: "editor" | "runtime" },
): Promise<GuestInstall[]>;
