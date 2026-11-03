import { readdir, readFile } from "node:fs/promises";
import { join, sep } from "node:path";

import type { GuestPackageLocator } from "./guest-installs.ts";

type ExportEntry = string | { import?: ExportEntry; default?: string; types?: string } | null;
type ExportMap = Record<string, ExportEntry>;

const ORM_COMMON_EXPORTS = new Set([
  ".",
  "./alias",
  "./batch",
  "./cache/core",
  "./casing",
  "./codecs",
  "./column",
  "./column-builder",
  "./column-common",
  "./entity",
  "./errors",
  "./logger",
  "./migrator",
  "./migrator.utils",
  "./operations",
  "./primary-key",
  "./query-promise",
  "./query-name-generator",
  "./relations",
  "./runnable-query",
  "./selection-proxy",
  "./session",
  "./sql",
  "./subquery",
  "./table",
  "./table.utils",
  "./tracing",
  "./tracing-utils",
  "./up-migrations/utils",
  "./used-tables",
  "./utils",
  "./version",
  "./view",
  "./view-common",
]);
const ORM_COMMON_EXPORT_PREFIXES = ["./query-builders/", "./sql/"];
const ORM_VALIDATOR_EXPORTS = ["./arktype", "./typebox", "./typebox-legacy", "./valibot", "./zod"];

/** The TypeScript the guest catalog declares the inventory with. */
export const ORM_EXPORT_INVENTORY_INTERFACE = [
  "export interface OrmExportInventory {",
  "  readonly common: readonly string[];",
  "  readonly postgresql: readonly string[];",
  "  readonly sqlite: readonly string[];",
  "  readonly validators: readonly string[];",
  "  readonly effect: {",
  "    readonly common: readonly string[];",
  "    readonly postgresql: readonly string[];",
  "    readonly sqlite: readonly string[];",
  "  };",
  "}",
].join("\n");

function isExportFamily(exportPath: string, family: string) {
  return exportPath === family || exportPath.startsWith(`${family}/`);
}

function isInExportFamilyList(exportPath: string, families: string[]) {
  return families.some((family) => isExportFamily(exportPath, family));
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The ESM code and declaration targets of one exports entry, such as `{ code: "./*.js", types: "./*.d.ts" }`. */
function toEsmTargets(entry: ExportEntry): { code: string | undefined; types: string | undefined } {
  if (typeof entry === "string") {
    return { code: entry, types: undefined };
  }

  const esm = entry?.import ?? entry;

  if (typeof esm === "string") {
    return { code: esm, types: entry?.types };
  }

  return { code: esm?.default, types: esm?.types ?? entry?.types };
}

/**
 * Expand one wildcard export, such as `"./*": "./*.js"`, against the package's files
 *
 * Each file that matches the ESM code target and has the matching declaration file is one subpath. A `.../index`
 * match is left out: drizzle-orm ships `pg-core.js` next to `pg-core/index.js`, and its exact exports maps named only
 * `./pg-core`.
 */
function expandExportPattern({
  pattern,
  entry,
  packageFiles,
}: {
  pattern: string;
  entry: ExportEntry;
  packageFiles: string[];
}) {
  const { code, types } = toEsmTargets(entry);

  if (typeof code !== "string" || code.split("*").length !== 2) {
    throw new Error(`Expected one wildcard in the ESM target of export ${pattern}, but got ${JSON.stringify(entry)}`);
  }

  const [codePrefix, codeSuffix] = code.split("*");

  return packageFiles.flatMap((file) => {
    if (!file.startsWith(codePrefix) || !file.endsWith(codeSuffix) || file.length < code.length - 1) {
      return [];
    }

    const match = file.slice(codePrefix.length, file.length - codeSuffix.length);
    const hasDeclaration = typeof types !== "string" || packageFiles.includes(types.replace("*", match));

    if (!hasDeclaration || match === "index" || match.endsWith("/index")) {
      return [];
    }

    return [pattern.replace("*", match)];
  });
}

/**
 * List the exact subpaths of an exports map
 *
 * Exact keys are listed as they are; wildcard keys are expanded against `packageFiles`, the package's files as
 * `./`-relative paths. drizzle-orm publishes exact keys up to 1.0.0-rc.4 and a `"./*"` pattern from 1.0.0-rc.5.
 */
function listExportPaths({ exports, packageFiles }: { exports: ExportMap; packageFiles: string[] }) {
  const subpathKeys = Object.keys(exports).filter((key) => key === "." || key.startsWith("./"));
  const exactPaths = subpathKeys.filter((key) => !key.includes("*") && exports[key] !== null);
  const patternPaths = subpathKeys
    .filter((key) => key.includes("*") && exports[key] !== null)
    .flatMap((pattern) => expandExportPattern({ pattern, entry: exports[pattern], packageFiles }));

  return [...new Set([...exactPaths, ...patternPaths])];
}

/**
 * List the exact drizzle-orm subpaths user code may import, by family
 *
 * Reads them from one drizzle-orm `package.json` exports map, with wildcard exports expanded against `packageFiles`:
 * the common modules, each dialect's, the validator integrations on Next, and the Effect integrations when the pair
 * ships an `effect` guest. Throws when the exports map is not subpaths or when the root export is missing.
 */
export function toOrmExportInventory({
  packageMetadata,
  packageFiles,
  releaseLine,
  hasEffectFlavor,
}: {
  packageMetadata: { version: string; exports: ExportMap };
  packageFiles: string[];
  releaseLine: "legacy" | "next";
  hasEffectFlavor: boolean;
}) {
  const packageName = "drizzle-orm";
  const exports = packageMetadata.exports;

  if (exports === null || typeof exports !== "object" || Array.isArray(exports)) {
    throw new Error(`Expected subpath exports for ${packageName}@${packageMetadata.version}`);
  }

  const exportPaths = listExportPaths({ exports, packageFiles });
  const common = exportPaths.filter(
    (exportPath) =>
      ORM_COMMON_EXPORTS.has(exportPath) ||
      ORM_COMMON_EXPORT_PREFIXES.some((prefix) => exportPath.startsWith(prefix)) ||
      (exportPath.startsWith("./cache/core/") && exportPath !== "./cache/core/cache-effect"),
  );
  // Aurora DSQL needs AWS's connector, which no guest ships.
  const postgresql = exportPaths.filter(
    (exportPath) =>
      isInExportFamilyList(exportPath, ["./pg-core", "./node-postgres", "./up-migrations/pg"]) &&
      !isInExportFamilyList(exportPath, ["./node-postgres/dsql", "./pg-core/async/dsql"]),
  );
  const sqlite = exportPaths.filter((exportPath) =>
    isInExportFamilyList(exportPath, ["./sqlite-core", "./libsql", "./up-migrations/sqlite"]),
  );
  const validators =
    releaseLine === "next"
      ? exportPaths.filter((exportPath) => isInExportFamilyList(exportPath, ORM_VALIDATOR_EXPORTS))
      : [];
  // The effect guest flavor adds Effect Schema and the Effect drivers that run on the guest's own database clients.
  const effectExports = (families: string[]) =>
    hasEffectFlavor ? exportPaths.filter((exportPath) => isInExportFamilyList(exportPath, families)) : [];
  const effect = {
    common: effectExports(["./effect-schema"]),
    postgresql: effectExports(["./effect-postgres"]),
    sqlite: effectExports(["./effect-libsql"]),
  };
  const selected = new Set([
    ...common,
    ...postgresql,
    ...sqlite,
    ...validators,
    ...effect.common,
    ...effect.postgresql,
    ...effect.sqlite,
  ]);

  if (!selected.has(".")) {
    throw new Error(`The root ORM export is missing from ${packageName}@${packageMetadata.version}`);
  }

  const toSpecifiers = (paths: string[]) =>
    [...paths].toSorted(compareText).map((path) => (path === "." ? packageName : `${packageName}/${path.slice(2)}`));

  return {
    common: toSpecifiers(common),
    postgresql: toSpecifiers(postgresql),
    sqlite: toSpecifiers(sqlite),
    validators: toSpecifiers(validators),
    effect: {
      common: toSpecifiers(effect.common),
      postgresql: toSpecifiers(effect.postgresql),
      sqlite: toSpecifiers(effect.sqlite),
    },
  };
}

/**
 * Read the ORM export inventory of every pinned drizzle-orm version
 *
 * Keyed by version in guest id order. Each version reads the installed drizzle-orm of the first slim guest that pins
 * it, and takes its release line and Effect integrations from that guest's pair.
 *
 * @param {import("./guest-installs.ts").GuestPackageLocator} locator
 */
export async function readOrmExportInventory({ guests, locate }: GuestPackageLocator) {
  const inventory: Record<string, ReturnType<typeof toOrmExportInventory>> = {};

  for (const guest of guests) {
    if (guest.guestFlavor !== "slim" || Object.hasOwn(inventory, guest.ormVersion)) {
      continue;
    }

    const directory = locate("drizzle-orm", guest.ormVersion);
    const [packageMetadata, packageFiles] = await Promise.all([
      readFile(join(directory, "package.json"), "utf8").then((text) => JSON.parse(text)),
      readdir(directory, { recursive: true }).then((files) => files.map((file) => `./${file.split(sep).join("/")}`)),
    ]);

    inventory[guest.ormVersion] = toOrmExportInventory({
      packageMetadata,
      packageFiles,
      releaseLine: guest.releaseLine,
      hasEffectFlavor: guests.some(
        (candidate) => candidate.pairId === guest.pairId && candidate.guestFlavor === "effect",
      ),
    });
  }

  return inventory;
}
