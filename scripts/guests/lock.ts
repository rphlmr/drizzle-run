// Lock each guest package from its own package.json: `node scripts/guests/lock.ts`.
//
// A guest whose lock root already lists its package.json pins is left alone; any other guest, a new one included,
// gets `npm install --package-lock-only`. This reads no catalog, so it also locks a guest the catalog does not know
// yet; `pnpm guests:sync` regenerates the catalog afterwards.
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const guestsDir = join(rootDir, "guests");
// The guest pins supported dialect peers directly. Other optional ORM peers target unadmitted dialects.
const npmLockFlags = [
  "install",
  "--package-lock-only",
  "--ignore-scripts",
  "--legacy-peer-deps",
  "--no-audit",
  "--no-fund",
  "--package-lock=true",
];

async function readLockRoot(guestDir: string) {
  try {
    return JSON.parse(await readFile(join(guestDir, "package-lock.json"), "utf8")).packages?.[""];
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return undefined;
    }

    throw cause;
  }
}

/**
 * Lock every guest whose lock does not list its package.json pins
 *
 * Returns the ids of the guests it relocked, sorted. A guest without a lock counts as stale.
 *
 * @returns {Promise<string[]>}
 */
export async function lockGuests() {
  const entries = await readdir(guestsDir, { withFileTypes: true });
  const guestIds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
  const relockedIds = [];

  for (const guestId of guestIds) {
    const guestDir = join(guestsDir, guestId);
    const [manifest, lockRoot] = await Promise.all([
      readFile(join(guestDir, "package.json"), "utf8").then(JSON.parse),
      readLockRoot(guestDir),
    ]);
    const lockIsCurrent =
      lockRoot !== undefined &&
      JSON.stringify(lockRoot.dependencies ?? {}) === JSON.stringify(manifest.dependencies ?? {}) &&
      JSON.stringify(lockRoot.devDependencies ?? {}) === JSON.stringify(manifest.devDependencies ?? {});

    if (lockIsCurrent) {
      console.log(`Guest lock for ${guestId} is current.`);
      continue;
    }

    execFileSync("npm", npmLockFlags, { cwd: guestDir, stdio: "inherit" });
    relockedIds.push(guestId);
    console.log(`Refreshed the guest lock for ${guestId}.`);
  }

  return relockedIds;
}

if (import.meta.main) {
  await lockGuests();
}
