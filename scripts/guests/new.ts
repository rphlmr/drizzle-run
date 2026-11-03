import { existsSync } from "node:fs";
// Scaffold a release pair's guest folders from an existing pair:
//
//   pnpm guests:new --orm <version> --kit <version> --from <pair id>
//     [--flavor <flavor>]... [--pin [<flavor>:]<name>@<version>]... [--orm-api v<n>] [--kit-api v<n>] [--replace]
//
// Each new guest copies its pins from the matching guest of `--from` (a new flavor copies the slim guest), takes the
// new drizzle-orm and drizzle-kit, and moves drizzle-seed with the ORM when the source pins them in lockstep. A
// `--pin` without a flavor applies to the slim guest and every flavor, which keeps each flavor a superset of its slim
// guest; `effect:effect@4.0.0` pins only the effect guest. A new pair is never recommended. `--replace` is the Legacy
// in-place bump: the new pair keeps the source's metadata, recommendation included, and the source folders are
// deleted. Nothing is locked or installed here; `pnpm guests:sync` does that next.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { type GuestPackage, readGuestPackages, toGuestImageId, toGuestPackageName } from "./guest-packages.ts";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const guestsDir = join(rootDir, "guests");
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const flavorPattern = /^[a-z]+$/;
const apiVersionPattern = /^v\d+$/;

/**
 * Parse a `--pin` value
 *
 * `zod@4.4.4` pins every new guest; `effect:effect@4.0.0` pins only the effect guest. Throws on a range or a missing
 * version.
 */
function toPin(value: string) {
  const match = /^(?:(?<flavor>[a-z]+):)?(?<name>@?[^@\s]+)@(?<version>[^@\s]+)$/.exec(value);

  if (match === null || match.groups === undefined || !exactVersionPattern.test(match.groups.version)) {
    throw new Error(`Expected --pin [<flavor>:]<name>@<exact version>, such as zod@4.4.4, but got ${value}`);
  }

  return { flavor: match.groups.flavor ?? null, name: match.groups.name, version: match.groups.version };
}

function sortByName(pins: Record<string, string>) {
  return Object.fromEntries(Object.entries(pins).toSorted(([left], [right]) => (left < right ? -1 : 1)));
}

function readOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      orm: { type: "string" },
      kit: { type: "string" },
      from: { type: "string" },
      flavor: { type: "string", multiple: true, default: [] },
      pin: { type: "string", multiple: true, default: [] },
      "orm-api": { type: "string" },
      "kit-api": { type: "string" },
      replace: { type: "boolean", default: false },
    },
  });

  if (values.orm === undefined || values.kit === undefined || values.from === undefined) {
    throw new Error(
      "Pass --orm <version> --kit <version> --from <pair id>, such as --from orm-1.0.0-rc.5__kit-1.0.0-rc.5",
    );
  }

  for (const [flag, version] of [
    ["--orm", values.orm],
    ["--kit", values.kit],
  ]) {
    if (!exactVersionPattern.test(version)) {
      throw new Error(`Expected ${flag} to be an exact version, such as 1.0.0-rc.5, but got ${version}`);
    }
  }

  for (const [flag, api] of [
    ["--orm-api", values["orm-api"]],
    ["--kit-api", values["kit-api"]],
  ]) {
    if (api !== undefined && !apiVersionPattern.test(api)) {
      throw new Error(`Expected ${flag} to be v<number>, such as v1, but got ${api}`);
    }
  }

  const unknownFlavor = values.flavor.find((flavor) => flavor === "slim" || !flavorPattern.test(flavor));

  if (unknownFlavor !== undefined) {
    throw new Error(
      `Expected --flavor to name a flavor other than slim, in lowercase letters, but got ${unknownFlavor}`,
    );
  }

  return { ...values, orm: values.orm, kit: values.kit, from: values.from, pins: values.pin.map(toPin) };
}

/** Build the package.json of one new guest from its source guest. */
function toGuestManifest({
  imageId,
  flavor,
  source,
  options,
  slimMetadata,
}: {
  imageId: string;
  flavor: string;
  source: GuestPackage;
  options: ReturnType<typeof readOptions>;
  slimMetadata: GuestPackage["manifest"]["drizzleRun"];
}) {
  const sourcePinsSeedInLockstep = source.dependencies["drizzle-seed"] === source.ormVersion;
  const dependencies: Record<string, string> = {
    ...source.dependencies,
    "drizzle-orm": options.orm,
    "drizzle-kit": options.kit,
    ...(sourcePinsSeedInLockstep ? { "drizzle-seed": options.orm } : {}),
  };
  const devDependencies = { ...source.devDependencies };

  for (const pin of options.pins) {
    if (pin.flavor !== null && pin.flavor !== flavor) {
      continue;
    }

    const section = Object.hasOwn(devDependencies, pin.name) ? devDependencies : dependencies;
    section[pin.name] = pin.version;
  }

  return {
    name: toGuestPackageName(imageId),
    private: true,
    type: "module",
    version: "1.0.0",
    description: source.manifest.description,
    drizzleRun: flavor === "slim" ? slimMetadata : { flavor },
    dependencies: sortByName(dependencies),
    devDependencies: sortByName(devDependencies),
  };
}

async function main(args: string[]) {
  const options = readOptions(args);
  const guests = await readGuestPackages(guestsDir);
  const sourceGuests = guests.filter((guest) => guest.pairId === options.from);
  const sourceSlim = sourceGuests.find((guest) => guest.guestFlavor === "slim");

  if (sourceSlim === undefined) {
    throw new Error(
      `Unknown pair ${options.from}; expected one of ${[...new Set(guests.map((guest) => guest.pairId))].join(", ")}`,
    );
  }

  // The new pair has every flavor of its source plus the requested ones.
  const flavors = [
    "slim",
    ...new Set([
      ...sourceGuests.filter((guest) => guest.guestFlavor !== "slim").map((guest) => guest.guestFlavor),
      ...options.flavor,
    ]),
  ];
  const sourceMetadata = sourceSlim.manifest.drizzleRun;
  const slimMetadata: GuestPackage["manifest"]["drizzleRun"] = {
    ...sourceMetadata,
    releaseLine: options.orm.startsWith("0.") ? "legacy" : "next",
    recommended: options.replace ? sourceMetadata.recommended : false,
    ormApi: options["orm-api"] ?? sourceMetadata.ormApi,
    kitApi: options["kit-api"] ?? sourceMetadata.kitApi,
  };
  const unknownPinFlavor = options.pins.find((pin) => pin.flavor !== null && !flavors.includes(pin.flavor));

  if (unknownPinFlavor !== undefined) {
    throw new Error(
      `--pin names flavor ${unknownPinFlavor.flavor}, which the new pair does not have; add --flavor ${unknownPinFlavor.flavor}`,
    );
  }

  const targets = flavors.map((flavor) => {
    const imageId = toGuestImageId({ ormVersion: options.orm, kitVersion: options.kit, guestFlavor: flavor });

    return { flavor, imageId, directory: join(guestsDir, imageId) };
  });
  const existingTarget = targets.find((target) => existsSync(target.directory));

  if (existingTarget !== undefined) {
    throw new Error(`guests/${existingTarget.imageId} already exists; delete it or pick other versions`);
  }

  const written = [];

  for (const { flavor, imageId, directory } of targets) {
    const source = sourceGuests.find((guest) => guest.guestFlavor === flavor) ?? sourceSlim;
    const manifest = toGuestManifest({ imageId, flavor, source, options, slimMetadata });

    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    written.push(relative(rootDir, directory));
  }

  if (options.replace) {
    for (const guest of sourceGuests) {
      await rm(guest.directory, { recursive: true, force: true });
    }
  }

  console.log(`Wrote ${written.join(", ")}${options.replace ? `; removed the ${options.from} guests` : ""}.`);
  console.log("Next: pnpm guests:sync, then pnpm guests:check (guests/README.md has the whole runbook).");
}

await main(process.argv.slice(2));
