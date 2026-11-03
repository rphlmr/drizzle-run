import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

/** A guest's pins and pair metadata, validated from its manifest and lock. */
export interface GuestPackage {
  id: string;
  pairId: string;
  guestFlavor: string;
  ormVersion: string;
  kitVersion: string;
  releaseLine: "legacy" | "next";
  recommended: boolean;
  ormApi: string;
  kitApi: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  manifest: GuestManifest;
  lockDigest: string;
  integrities: Record<string, string>;
  directory: string;
}

interface GuestMetadata {
  flavor: string;
  releaseLine: "legacy" | "next";
  recommended: boolean;
  ormApi: string;
  kitApi: string;
}

interface GuestManifest {
  name: string;
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  drizzleRun: GuestMetadata;
}

interface GuestLock {
  lockfileVersion: number;
  packages: Record<
    string,
    {
      version?: string;
      integrity: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }
  >;
}

type ParsedGuest = Awaited<ReturnType<typeof readGuestFolder>>;

const imageIdPattern = /^orm-(?<ormVersion>[^_+]+)__kit-(?<kitVersion>[^_+]+?)(?:\+(?<flavor>[a-z]+))?$/;
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const apiVersionPattern = /^v\d+$/;
const releaseLines = ["legacy", "next"];
const slimMetadataKeys = ["flavor", "releaseLine", "recommended", "ormApi", "kitApi"];

/**
 * Get a guest image id
 *
 * Mirrors `toGuestImageId` in `packages/core/src/registry/guest-images.ts`, which the guest scripts must not import:
 * the slim image keeps the plain pair id, other flavors append `+<flavor>`.
 */
export function toGuestImageId({
  ormVersion,
  kitVersion,
  guestFlavor,
}: {
  ormVersion: string;
  kitVersion: string;
  guestFlavor: string;
}) {
  const pairId = `orm-${ormVersion}__kit-${kitVersion}`;

  return guestFlavor === "slim" ? pairId : `${pairId}+${guestFlavor}`;
}

/** Get the npm package name a guest image's `package.json` must carry. */
export function toGuestPackageName(imageId: string) {
  return `drizzle-run-guest-${imageId.replaceAll(".", "-").replaceAll("_", "-").replaceAll("+", "-")}`;
}

/** Get the `lockDigest` of a guest lock file's bytes. */
export function toLockDigest(lockBytes: Uint8Array) {
  return `sha256-${createHash("sha256").update(lockBytes).digest("hex")}`;
}

/**
 * Read and validate every guest package
 *
 * Reads `guests/<image-id>/package.json` and `package-lock.json` only, never core's registry. Throws on the first
 * broken rule: a folder name that is not an image id, a range instead of an exact pin, a lock that resolves another
 * version, pair metadata outside the slim guest, a flavor guest that drifts from its slim guest, or not exactly one
 * recommended pair and one Legacy pair. Returns the guests sorted by id, each flavor carrying its pair's metadata.
 *
 * @param {string} guestsDir Absolute path of the root `guests/` folder
 * @returns {Promise<GuestPackage[]>}
 */
export async function readGuestPackages(guestsDir: string): Promise<GuestPackage[]> {
  const entries = await readdir(guestsDir, { withFileTypes: true });
  const folderNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted(compareText);
  const parsed = await Promise.all(folderNames.map((folderName) => readGuestFolder(join(guestsDir, folderName))));
  const slimByPairId = new Map(
    parsed.filter((guest) => guest.guestFlavor === "slim").map((guest) => [guest.pairId, guest]),
  );

  const guests = parsed.map(({ metadata: _metadata, ...guest }) => {
    const slim = slimByPairId.get(guest.pairId);

    if (slim === undefined) {
      throw new Error(`Guest ${guest.id} has no slim guest ${guest.pairId} beside it`);
    }

    if (guest.guestFlavor !== "slim") {
      assertFlavorSupersetsSlim(guest, slim);
    }

    return {
      ...guest,
      releaseLine: slim.metadata.releaseLine,
      recommended: slim.metadata.recommended,
      ormApi: slim.metadata.ormApi,
      kitApi: slim.metadata.kitApi,
    };
  });

  assertReleaseLineRules([...slimByPairId.values()]);

  return guests;
}

async function readGuestFolder(directory: string) {
  const id = basename(directory);
  const match = imageIdPattern.exec(id);

  if (match === null || match.groups === undefined) {
    throw new Error(`Guest folder guests/${id} is not a guest image id (orm-<version>__kit-<version>[+<flavor>])`);
  }

  const { ormVersion, kitVersion } = match.groups;
  const guestFlavor = match.groups.flavor ?? "slim";

  if (toGuestImageId({ ormVersion, kitVersion, guestFlavor }) !== id) {
    throw new Error(`Guest folder guests/${id} does not round-trip as a guest image id`);
  }

  const [manifestText, lockBytes] = await Promise.all([
    readFile(join(directory, "package.json"), "utf8"),
    readFile(join(directory, "package-lock.json")),
  ]);
  const manifest: GuestManifest = JSON.parse(manifestText);
  const lock: GuestLock = JSON.parse(lockBytes.toString("utf8"));
  const dependencies = manifest.dependencies ?? {};
  const devDependencies = manifest.devDependencies ?? {};

  if (manifest.name !== toGuestPackageName(id)) {
    throw new Error(`Guest ${id} must be named ${toGuestPackageName(id)}, but package.json names ${manifest.name}`);
  }

  const metadata = assertGuestMetadata(id, guestFlavor, manifest.drizzleRun);
  assertExactPins(id, "dependencies", dependencies);
  assertExactPins(id, "devDependencies", devDependencies);

  if (dependencies["drizzle-orm"] !== ormVersion || dependencies["drizzle-kit"] !== kitVersion) {
    throw new Error(
      `Guest ${id} must pin drizzle-orm ${ormVersion} and drizzle-kit ${kitVersion}, but pins ${dependencies["drizzle-orm"]} and ${dependencies["drizzle-kit"]}`,
    );
  }

  assertLockMatchesPins(id, lock, dependencies, devDependencies);

  return {
    id,
    pairId: toGuestImageId({ ormVersion, kitVersion, guestFlavor: "slim" }),
    guestFlavor,
    ormVersion,
    kitVersion,
    dependencies,
    devDependencies,
    manifest,
    lockDigest: toLockDigest(lockBytes),
    integrities: Object.fromEntries(
      Object.keys({ ...dependencies, ...devDependencies }).map((name) => [
        name,
        lock.packages[`node_modules/${name}`].integrity,
      ]),
    ),
    directory,
    metadata,
  };
}

function assertGuestMetadata(id: string, guestFlavor: string, metadata: GuestMetadata) {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error(`Guest ${id} needs a "drizzleRun" object in package.json`);
  }

  if (metadata.flavor !== guestFlavor) {
    throw new Error(`Guest ${id} sets drizzleRun.flavor to ${metadata.flavor}, expected ${guestFlavor}`);
  }

  const keys = Object.keys(metadata);

  if (guestFlavor !== "slim") {
    if (keys.length !== 1) {
      throw new Error(
        `Flavor guest ${id} sets ${keys.filter((key) => key !== "flavor").join(", ")}; only its slim guest carries pair metadata`,
      );
    }

    return metadata;
  }

  if (keys.length !== slimMetadataKeys.length || !slimMetadataKeys.every((key) => Object.hasOwn(metadata, key))) {
    throw new Error(
      `Slim guest ${id} must set exactly drizzleRun.${slimMetadataKeys.join(", ")}; got ${keys.join(", ")}`,
    );
  }

  if (
    !releaseLines.includes(metadata.releaseLine) ||
    typeof metadata.recommended !== "boolean" ||
    !apiVersionPattern.test(metadata.ormApi) ||
    !apiVersionPattern.test(metadata.kitApi)
  ) {
    throw new Error(`Slim guest ${id} has invalid drizzleRun metadata: ${JSON.stringify(metadata)}`);
  }

  return metadata;
}

function assertExactPins(id: string, section: string, pins: Record<string, string>) {
  for (const [name, version] of Object.entries(pins)) {
    if (typeof version !== "string" || !exactVersionPattern.test(version)) {
      throw new Error(`Guest ${id} pins ${name}@${version} in ${section}; every guest version is exact`);
    }
  }
}

function assertLockMatchesPins(
  id: string,
  lock: GuestLock,
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
) {
  const root = lock.packages?.[""];

  if (lock.lockfileVersion !== 3 || root === undefined) {
    throw new Error(`Guest ${id} needs an npm package-lock.json with lockfileVersion 3`);
  }

  if (
    JSON.stringify(root.dependencies ?? {}) !== JSON.stringify(dependencies) ||
    JSON.stringify(root.devDependencies ?? {}) !== JSON.stringify(devDependencies)
  ) {
    throw new Error(`Guest ${id} package-lock.json is stale; refresh it with pnpm guests:sync`);
  }

  for (const [name, version] of Object.entries({ ...dependencies, ...devDependencies })) {
    const resolved = lock.packages[`node_modules/${name}`]?.version;

    if (resolved !== version) {
      throw new Error(`Guest ${id} pins ${name}@${version}, but its lock resolves ${resolved ?? "nothing"}`);
    }
  }
}

function assertFlavorSupersetsSlim(
  guest: Pick<ParsedGuest, "id" | "dependencies" | "devDependencies">,
  slim: Pick<ParsedGuest, "id" | "dependencies" | "devDependencies">,
) {
  for (const section of ["dependencies", "devDependencies"] as const) {
    for (const [name, version] of Object.entries(slim[section])) {
      if (guest[section][name] !== version) {
        throw new Error(
          `Flavor guest ${guest.id} pins ${name}@${guest[section][name] ?? "nothing"} in ${section}, but its slim guest pins ${version}`,
        );
      }
    }
  }
}

function assertReleaseLineRules(slimGuests: ParsedGuest[]) {
  const recommended = slimGuests.filter((guest) => guest.metadata.recommended);
  const legacy = slimGuests.filter((guest) => guest.metadata.releaseLine === "legacy");

  if (recommended.length !== 1) {
    throw new Error(
      `Exactly one guest pair is recommended; found ${recommended.map((guest) => guest.id).join(", ") || "none"}`,
    );
  }

  if (legacy.length !== 1) {
    throw new Error(
      `Legacy keeps exactly one guest pair; found ${legacy.map((guest) => guest.id).join(", ") || "none"}`,
    );
  }
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
