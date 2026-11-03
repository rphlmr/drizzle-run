// Typecheck the ORM and Kit corpus against each guest: `node scripts/typecheck-corpus.ts [<image-id>...]`.
import { execFileSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readGuestPackages } from "../../../scripts/guests/guest-packages.ts";
import type { GuestPackage } from "../../../scripts/guests/guest-packages.ts";
import { installGuests } from "../../../scripts/guests/install.ts";

const harnessDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = resolve(harnessDir, "../..");
const tsconfigDir = join(rootDir, ".cache/harness-corpus");
const corpusDirs = [join(harnessDir, "src/orm-corpus"), join(harnessDir, "src/kit-corpus")];
const tscPath = join(harnessDir, "node_modules/.bin/tsc");
// Each ORM API has its own corpus files; the files without one of these prefixes are shared.
const corpusPrefixByOrmApi: Readonly<Record<string, string>> = { v0: "legacy", v1: "next" };
const corpusPrefixes = Object.values(corpusPrefixByOrmApi);

/** List the corpus files one ORM API typechecks: its own files and the shared ones. */
async function listCorpusFiles(ormApi: string) {
  const prefix = corpusPrefixByOrmApi[ormApi];

  if (prefix === undefined) {
    throw new Error(
      `No ORM corpus is registered for ORM API ${ormApi}; expected one of ${Object.keys(corpusPrefixByOrmApi).join(", ")}`,
    );
  }

  const files = [];

  for (const corpusDir of corpusDirs) {
    for (const name of (await readdir(corpusDir)).toSorted()) {
      const isOwnFile = name.startsWith(`${prefix}-`) || name.startsWith(`${prefix}.`);
      const isShared = !corpusPrefixes.some((other) => name.startsWith(`${other}-`) || name.startsWith(`${other}.`));

      if (name.endsWith(".ts") && (isOwnFile || isShared)) {
        files.push(join(corpusDir, name));
      }
    }
  }

  return files;
}

/** Write the tsconfig that checks one image's corpus against its own drizzle-orm, and return its path. */
async function writeCorpusTsconfig(guest: GuestPackage, install: Awaited<ReturnType<typeof installGuests>>[number]) {
  const ormDirectory = join(install.directory, "node_modules/drizzle-orm");
  const configDir = join(tsconfigDir, guest.id);
  const configPath = join(configDir, "tsconfig.json");
  const config = {
    extends: join(rootDir, "tsconfig.base.json"),
    compilerOptions: {
      noEmit: true,
      allowImportingTsExtensions: true,
      types: [],
      paths: {
        "drizzle-orm": [ormDirectory],
        "drizzle-orm/*": [`${ormDirectory}/*`],
      },
    },
    files: await listCorpusFiles(guest.ormApi),
  };

  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  return configPath;
}

async function main(imageIds: string[]) {
  const installs = await installGuests(imageIds);
  const guests = await readGuestPackages(join(rootDir, "guests"));
  const failures = [];

  for (const install of installs) {
    const guest = guests.find((candidate) => candidate.id === install.imageId);

    if (guest === undefined) {
      throw new Error(`Installed guest ${install.imageId} has no folder in guests/`);
    }

    const configPath = await writeCorpusTsconfig(guest, install);

    try {
      execFileSync(tscPath, ["-p", configPath], { cwd: harnessDir, stdio: "inherit" });
      console.log(`${guest.id}: corpus typechecks against drizzle-orm@${guest.ormVersion}`);
    } catch {
      failures.push(`${guest.id} (${relative(rootDir, configPath)})`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`The corpus does not typecheck against these guests:\n- ${failures.join("\n- ")}`);
  }
}

await main(process.argv.slice(2));
