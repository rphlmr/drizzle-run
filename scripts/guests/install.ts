import { execFileSync } from "node:child_process";
// Install each guest package into the cache: `node scripts/guests/install.ts [--runtime] [<image-id>...]`.
//
// A guest installs with `npm ci` into one of two variants, each keyed by everything its installed tree depends on, so
// an unchanged guest is never installed twice and a changed one never reuses a tree:
// - `editor` in .cache/guests/<image-id>/<installKey>/, with the devDependencies: the type artifacts and the harness
//   corpus typecheck read the editor types from it.
// - `runtime` in .cache/guest-runtime-installs/<image-id>/<installKey>/, with --omit=dev: guest images are built from
//   it, so the shipped tree never holds an editor type.
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type GuestPackage, readGuestPackages } from "./guest-packages.ts";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const guestsDir = join(rootDir, "guests");
const baseNpmCiFlags = ["--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"];

/** Where each install variant lives and how `npm ci` builds it. */
export const INSTALL_VARIANTS = {
  editor: { cacheDir: join(rootDir, ".cache/guests"), npmCiFlags: baseNpmCiFlags, includesDev: true },
  runtime: {
    cacheDir: join(rootDir, ".cache/guest-runtime-installs"),
    npmCiFlags: ["--omit=dev", ...baseNpmCiFlags],
    includesDev: false,
  },
};
const installRecordName = "drizzle-run-install.json";

/** An installed guest tree, keyed by its pins, lock and install options. */
export interface GuestInstall {
  imageId: string;
  installKey: string;
  directory: string;
  cached: boolean;
}

type InstallVariant = keyof typeof INSTALL_VARIANTS;

/** Read the major version of the npm that installs the guests; it is part of every install key. */
export function readNpmMajor() {
  const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();

  return Number.parseInt(npmVersion.split(".")[0], 10);
}

/** Get the install key of a guest in a variant: sha256 of its lock, its pins, the npm major and the install flags. */
export function toInstallKey(guest: GuestPackage, npmMajor: number, variant: InstallVariant = "editor") {
  const keySource = JSON.stringify({
    lockDigest: guest.lockDigest,
    dependencies: guest.dependencies,
    devDependencies: guest.devDependencies,
    npmMajor,
    npmCiFlags: INSTALL_VARIANTS[variant].npmCiFlags,
  });

  return createHash("sha256").update(keySource).digest("hex");
}

async function readInstallRecord(directory: string) {
  try {
    return JSON.parse(await readFile(join(directory, installRecordName), "utf8"));
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return null;
    }

    throw cause;
  }
}

async function assertInstalledPins(guest: GuestPackage, directory: string, variant: InstallVariant) {
  const pins = INSTALL_VARIANTS[variant].includesDev
    ? { ...guest.dependencies, ...guest.devDependencies }
    : guest.dependencies;

  for (const [name, version] of Object.entries(pins)) {
    const installed = JSON.parse(await readFile(join(directory, "node_modules", name, "package.json"), "utf8"));

    if (installed.version !== version) {
      throw new Error(`Guest ${guest.id} installed ${name}@${installed.version}, expected ${version}`);
    }
  }
}

async function installGuest(guest: GuestPackage, npmMajor: number, variant: InstallVariant): Promise<GuestInstall> {
  const { cacheDir, npmCiFlags } = INSTALL_VARIANTS[variant];
  const installKey = toInstallKey(guest, npmMajor, variant);
  const imageCacheDir = join(cacheDir, guest.id);
  const directory = join(imageCacheDir, installKey);
  const record = await readInstallRecord(directory);

  if (record?.installKey === installKey) {
    return { imageId: guest.id, installKey, directory, cached: true };
  }

  // Install beside the final folder and rename it into place, so an interrupted install is never reused.
  await mkdir(imageCacheDir, { recursive: true });
  const stagingDir = await mkdtemp(join(imageCacheDir, ".staging-"));

  try {
    await Promise.all([
      cp(join(guest.directory, "package.json"), join(stagingDir, "package.json")),
      cp(join(guest.directory, "package-lock.json"), join(stagingDir, "package-lock.json")),
    ]);
    execFileSync("npm", ["ci", ...npmCiFlags], { cwd: stagingDir, stdio: "inherit" });
    await assertInstalledPins(guest, stagingDir, variant);
    await writeFile(
      join(stagingDir, installRecordName),
      `${JSON.stringify({ imageId: guest.id, installKey, lockDigest: guest.lockDigest }, null, 2)}\n`,
    );
    await rm(directory, { recursive: true, force: true });
    await rename(stagingDir, directory);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }

  return { imageId: guest.id, installKey, directory, cached: false };
}

// Installs for older locks, and for guests that no longer exist, are never read again.
async function pruneInstallCache(installCacheDir: string, installs: GuestInstall[], allGuestIds: Set<string>) {
  const keepByImageId = new Map(installs.map((install) => [install.imageId, install.installKey]));
  let imageIds = [];

  try {
    imageIds = await readdir(installCacheDir);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return;
    }

    throw cause;
  }

  for (const imageId of imageIds) {
    if (!allGuestIds.has(imageId)) {
      await rm(join(installCacheDir, imageId), { recursive: true, force: true });
      continue;
    }

    const keep = keepByImageId.get(imageId);

    if (keep === undefined) {
      continue;
    }

    for (const entry of await readdir(join(installCacheDir, imageId))) {
      if (entry !== keep) {
        await rm(join(installCacheDir, imageId, entry), { recursive: true, force: true });
      }
    }
  }
}

/**
 * Install guest packages into the cache
 *
 * Installs every guest, or only the given image ids, in the `editor` variant unless `variant` says `runtime`, and
 * returns where each one is installed. Prints one line per guest saying whether its install was reused. Throws on an
 * unknown image id, on a guest that fails validation, or when `npm ci` installs a version other than the pin.
 *
 * @param {readonly string[]} [imageIds]
 * @param {{ variant?: keyof typeof INSTALL_VARIANTS }} [options]
 * @returns {Promise<GuestInstall[]>}
 */
export async function installGuests(
  imageIds: readonly string[] = [],
  { variant = "editor" }: { variant?: InstallVariant } = {},
): Promise<GuestInstall[]> {
  const guestPackages = await readGuestPackages(guestsDir);
  const allGuestIds = new Set(guestPackages.map((guest) => guest.id));
  const unknownId = imageIds.find((imageId) => !allGuestIds.has(imageId));

  if (unknownId !== undefined) {
    throw new Error(`Unknown guest image ${unknownId}; expected one of ${[...allGuestIds].join(", ")}`);
  }

  const selected = imageIds.length === 0 ? guestPackages : guestPackages.filter((guest) => imageIds.includes(guest.id));
  const npmMajor = readNpmMajor();
  const installs = [];

  // One npm ci at a time: each one is large, and parallel installs interleave their output.
  for (const guest of selected) {
    const install = await installGuest(guest, npmMajor, variant);

    installs.push(install);
    console.log(
      `Guest install ${guest.id} (${variant}): ${install.cached ? "reused" : "installed"} ${relative(rootDir, install.directory)}`,
    );
  }

  await pruneInstallCache(INSTALL_VARIANTS[variant].cacheDir, installs, allGuestIds);

  return installs;
}

if (import.meta.main) {
  const args = process.argv.slice(2);

  await installGuests(
    args.filter((arg) => arg !== "--runtime"),
    { variant: args.includes("--runtime") ? "runtime" : "editor" },
  );
}
