import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONNECT_ORIGIN, normalizePairingSecret } from "@drizzle-run/core/connect";
import * as z from "zod/mini";

/**
 * The pairings this computer remembers, one file per relay in `~/.drizzle-run`. The folder is
 * owner-only (0700) and the file too (0600): the secret is the end-to-end key.
 * `DRIZZLE_RUN_HOME` moves the folder, which tests use so they never touch the real home.
 */

/** A stored pairing. Older releases kept a single one in `connect.json`. */
export interface StoredPairing {
  secret: string;
  /** The Drizzle Run origin the pairing belongs to. */
  relay: string;
  /** An ISO timestamp. */
  pairedAt: string;
}

const LEGACY_PAIRING_FILE = "connect.json";
const PAIRING_FILE_PATTERN = /^connect-[a-f0-9]{64}\.json$/;

export function pairingFileName(relay: string): string {
  return `connect-${createHash("sha256").update(relay).digest("hex")}.json`;
}

const StoredPairingSchema = z.object({
  secret: z.pipe(
    z.string(),
    z.transform((secret, context) => {
      const normalized = normalizePairingSecret(secret);

      if (normalized === undefined) {
        context.issues.push({ code: "custom", input: secret, message: "Expected a pairing secret." });

        return z.NEVER;
      }

      return normalized;
    }),
  ),
  relay: z.string(),
  pairedAt: z.string(),
});

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Get the folder that holds the pairing
 *
 * `~/.drizzle-run`, or `DRIZZLE_RUN_HOME` when it is set and not empty.
 */
export function connectHome(env: NodeJS.ProcessEnv = process.env): string {
  const homeOverride = env.DRIZZLE_RUN_HOME;

  return homeOverride !== undefined && homeOverride !== "" ? homeOverride : join(homedir(), ".drizzle-run");
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** The folder, created owner-only, or tightened to owner-only when it exists. */
async function ensureHome(home: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });

  const homeStats = await lstat(home);

  if (!homeStats.isDirectory()) {
    throw new Error(`${home} is not a folder.`);
  }

  if ((homeStats.mode & 0o077) !== 0) {
    await chmod(home, 0o700);
  }
}

/**
 * Read the stored pairing
 *
 * Returns `undefined` when there is no file, or when it is not valid JSON or lacks a field.
 * Throws when the path is not a plain file (a link could point the secret somewhere else), or when the file cannot be
 * read, such as for its permissions.
 * Tightens a file that others could read to 0600.
 */
async function readPairingFile(path: string): Promise<StoredPairing | undefined> {
  let fileStats;

  try {
    fileStats = await lstat(path);
  } catch (cause) {
    if (isMissingFileError(cause)) {
      return undefined;
    }

    throw cause;
  }

  // A link could point the secret somewhere else; only a plain file is read.
  if (!fileStats.isFile()) {
    throw new Error(`${path} is not a plain file. Remove it and pair again.`);
  }

  if ((fileStats.mode & 0o077) !== 0) {
    await chmod(path, 0o600);
  }

  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new Error(`Cannot read the pairing at ${path}. Check its permissions, or remove it and pair again.`, {
      cause,
    });
  }

  const pairing = StoredPairingSchema.safeParse(parseJson(text));

  return pairing.success ? pairing.data : undefined;
}

/** Find a pairing for one origin, or prefer the public site and fall back to the most recent pairing. */
export async function readPairing(home = connectHome(), relay?: string): Promise<StoredPairing | undefined> {
  if (relay !== undefined) {
    const pairing = await readPairingFile(join(home, pairingFileName(relay)));

    if (pairing?.relay === relay) {
      return pairing;
    }

    const legacy = await readPairingFile(join(home, LEGACY_PAIRING_FILE));
    return legacy?.relay === relay ? legacy : undefined;
  }

  const production = await readPairing(home, DEFAULT_CONNECT_ORIGIN);

  if (production !== undefined) {
    return production;
  }

  const files = await readdir(home).catch((cause: unknown) => {
    if (isMissingFileError(cause)) {
      return [];
    }

    throw cause;
  });
  const pairings = await Promise.all(
    files
      .filter((name) => name === LEGACY_PAIRING_FILE || PAIRING_FILE_PATTERN.test(name))
      .map(async (name) => {
        const pairing = await readPairingFile(join(home, name));
        return pairing && (name === LEGACY_PAIRING_FILE || name === pairingFileName(pairing.relay))
          ? pairing
          : undefined;
      }),
  );

  return pairings
    .filter((pairing) => pairing !== undefined)
    .toSorted((first, second) => second.pairedAt.localeCompare(first.pairedAt))[0];
}

/** Write the pairing through a temp file created 0600, then rename it into place. */
export async function writePairing(pairing: StoredPairing, home = connectHome()): Promise<void> {
  await ensureHome(home);

  const path = join(home, pairingFileName(pairing.relay));
  const tempPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(tempPath, "wx", 0o600);

  try {
    try {
      await handle.writeFile(`${JSON.stringify(pairing, null, 2)}\n`);
    } finally {
      await handle.close();
    }
    await rename(tempPath, path);
  } finally {
    await rm(tempPath, { force: true });
  }
}

/** Forget one relay's pairing, including its legacy copy if present. */
export async function clearPairing(home = connectHome(), relay?: string): Promise<void> {
  const origin = relay ?? (await readPairing(home))?.relay;
  const legacyPath = join(home, LEGACY_PAIRING_FILE);
  const legacy = await readPairingFile(legacyPath);

  if (origin !== undefined) {
    await rm(join(home, pairingFileName(origin)), { force: true });
  }

  if (origin === undefined || legacy?.relay === origin) {
    await rm(legacyPath, { force: true });
  }
}
