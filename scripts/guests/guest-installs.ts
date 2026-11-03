import { join } from "node:path";

import { type GuestPackage, readGuestPackages } from "./guest-packages.ts";
import { installGuests } from "./install.ts";

/** Installed packages, selected in guest id order with matching lock integrities. */
export interface GuestPackageLocator {
  guests: GuestPackage[];
  locate: (packageName: string, version: string) => string;
  getPinnedPackage: (packageName: string, version: string) => PinnedPackage;
}

/** The package directory and the lock that provides its integrity. */
export interface PinnedPackage {
  directory: string;
  integrity: string;
  providerLockDigest: string;
}

/**
 * Install every guest and locate the packages they pin
 *
 * Installs into the cache first (an unchanged guest is reused). `locate` returns `node_modules/<name>` of the first
 * guest, by id, that pins `name@version`, so one folder serves every guest that pins it. It throws when no guest pins
 * that version, or when two guests lock it with different integrities, since their files could then differ.
 * `getPinnedPackage` returns the same folder with the integrity and the providing guest's lock, which content keys
 * of what is read from that folder are built from.
 *
 * @param {string} guestsDir Absolute path of the root `guests/` folder
 * @returns {Promise<GuestPackageLocator>}
 */
export async function createGuestPackageLocator(guestsDir: string): Promise<GuestPackageLocator> {
  const [guests, installs] = await Promise.all([readGuestPackages(guestsDir), installGuests()]);
  const installDirectories = new Map(installs.map((install) => [install.imageId, install.directory]));

  function getPinnedPackage(packageName: string, version: string) {
    const pinningGuests = guests.filter(
      (guest) => (guest.dependencies[packageName] ?? guest.devDependencies[packageName]) === version,
    );
    const [firstGuest] = pinningGuests;

    if (firstGuest === undefined) {
      throw new Error(`No guest pins ${packageName}@${version}; add it to a guest under guests/ first`);
    }

    const integrities = new Set(pinningGuests.map((guest) => guest.integrities[packageName]));

    if (integrities.size !== 1) {
      throw new Error(
        `Guests ${pinningGuests.map((guest) => guest.id).join(", ")} lock ${packageName}@${version} with different integrities; relock them with pnpm guests:sync`,
      );
    }

    const installDirectory = installDirectories.get(firstGuest.id);

    if (installDirectory === undefined) {
      throw new Error(`Guest ${firstGuest.id} was not installed`);
    }

    return {
      directory: join(installDirectory, "node_modules", packageName),
      integrity: firstGuest.integrities[packageName],
      providerLockDigest: firstGuest.lockDigest,
    };
  }

  return {
    guests,
    locate: (packageName, version) => getPinnedPackage(packageName, version).directory,
    getPinnedPackage,
  };
}
