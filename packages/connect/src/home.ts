import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { normalizePairingSecret } from "@drizzle-run/core/connect";
import * as z from "zod/mini";

/**
 * The pairing this computer remembers, in `~/.drizzle-run/connect.json`. The folder is
 * owner-only (0700) and the file too (0600): the secret is the end-to-end key.
 * `DRIZZLE_RUN_HOME` moves the folder, which tests use so they never touch the real home.
 */

/** A pairing as stored in `connect.json`. */
export interface StoredPairing {
  secret: string;
  /** The Drizzle Run origin the pairing belongs to. */
  relay: string;
  /** An ISO timestamp. */
  pairedAt: string;
}

const PAIRING_FILE_NAME = "connect.json";

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
export async function readPairing(home = connectHome()): Promise<StoredPairing | undefined> {
  const path = join(home, PAIRING_FILE_NAME);
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

/** Write the pairing through a temp file created 0600, then rename it into place. */
export async function writePairing(pairing: StoredPairing, home = connectHome()): Promise<void> {
  await ensureHome(home);

  const path = join(home, PAIRING_FILE_NAME);
  const tempPath = join(home, `${PAIRING_FILE_NAME}.${process.pid}.tmp`);
  const handle = await open(tempPath, "wx", 0o600);

  try {
    await handle.writeFile(`${JSON.stringify(pairing, null, 2)}\n`);
  } finally {
    await handle.close();
  }

  await rename(tempPath, path);
}

/** Forget the stored pairing. Does nothing when there is none. */
export async function clearPairing(home = connectHome()): Promise<void> {
  await rm(join(home, PAIRING_FILE_NAME), { force: true });
}
