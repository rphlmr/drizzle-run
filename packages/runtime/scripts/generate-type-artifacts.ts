import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as z from "zod/mini";

import { createGuestPackageLocator } from "../../../scripts/guests/guest-installs.ts";
import { APPROVED_MODULES } from "../../core/src/registry/approved-modules.ts";
import type { ApprovedModuleEntry } from "../../core/src/registry/types.ts";
import { findUnresolvedSpecifiers, resolveExportPattern } from "./package-exports.ts";

type TypeArtifactRef = ApprovedModuleEntry["types"]["closureArtifact"];
type DriverTypeArtifactRef = NonNullable<ApprovedModuleEntry["types"]["driverArtifact"]>;

interface DeclarationFile {
  uri: string;
  content: string;
}

interface CacheUse {
  cacheFolder: string;
  artifactKey: string;
  reused: boolean;
}

const PackageMetadataSchema = z.object({
  name: z.string(),
  version: z.string(),
  types: z.optional(z.string()),
  typings: z.optional(z.string()),
  exports: z.optional(z.unknown()),
});
type PackageMetadata = z.infer<typeof PackageMetadataSchema>;
const ExportConditionsSchema = z.record(z.string(), z.unknown());

/**
 * Build the declaration closures consumed by the public type-environment API.
 *
 * This intentionally imports the approved-module registry instead of keeping a
 * second list of supported packages here.  The registry remains the source of
 * truth for runtime/type symmetry; this script reads each package@version from
 * the installed guest that pins it, so no workspace alias is involved.
 *
 * Each manifest is cached in .cache/type-artifacts/<artifact>/<artifactKey>.json. The key covers everything the
 * manifest is read from, so an unchanged package skips its declaration closure walk.
 *
 * The manifests land in packages/runtime/artifacts/declarations, which is neither committed nor packed:
 * prepare-runtime-assets.ts gzips each one into the runtime asset inventory, and the editor fetches it from there.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const artifactRoot = resolve(packageRoot, "artifacts/declarations");
const typeArtifactCacheDir = resolve(repositoryRoot, ".cache/type-artifacts");

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// A change to how manifests are built invalidates every cached one.
const generatorSourceHash = hashText(
  [fileURLToPath(import.meta.url), resolve(packageRoot, "scripts/package-exports.ts")]
    .map((file) => readFileSync(file, "utf8"))
    .join("\0"),
);
const guestPackages = await createGuestPackageLocator(resolve(repositoryRoot, "guests"));

function getPackageDirectory(packageName: string, version: string): string {
  const directory = guestPackages.locate(packageName, version);

  if (!existsSync(join(directory, "package.json"))) {
    throw new Error(
      `Cannot generate declaration artifact for ${packageName}@${version}: ${directory} is not installed`,
    );
  }

  return directory;
}

function readPackageMetadata(directory: string): PackageMetadata {
  return PackageMetadataSchema.parse(JSON.parse(readFileSync(join(directory, "package.json"), "utf8")));
}

function chooseExportTarget(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    for (const candidate of value) {
      try {
        return chooseExportTarget(candidate);
      } catch {
        // Try the next conditional export branch.
      }
    }
  }

  const conditions = ExportConditionsSchema.safeParse(value);

  if (conditions.success) {
    for (const key of ["types", "import", "require", "default", "node", "browser"]) {
      if (key in conditions.data) {
        try {
          return chooseExportTarget(conditions.data[key]);
        } catch {
          // Try the next conditional export branch.
        }
      }
    }
  }

  throw new Error("No declaration-compatible export target");
}

function getDeclarationCandidates(target: string): string[] {
  const candidates: string[] = [];
  const extension = extname(target);

  if ([".d.ts", ".d.mts", ".d.cts"].some((declarationExtension) => target.endsWith(declarationExtension))) {
    candidates.push(target);
  } else if ([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(extension)) {
    // Effect's declarations import their siblings with source extensions, such as "./Pipeable.ts". TypeScript reads
    // "./external.cjs" as external.d.cts first, so zod's CommonJS entry keeps its own declarations, not the ESM ones.
    const stem = target.slice(0, -extension.length);
    const declarationExtensions: Record<string, string> = {
      ".mjs": ".d.mts",
      ".mts": ".d.mts",
      ".cjs": ".d.cts",
      ".cts": ".d.cts",
    };
    const ownDeclaration = declarationExtensions[extension] ?? ".d.ts";
    candidates.push(...new Set([`${stem}${ownDeclaration}`, `${stem}.d.ts`, `${stem}.d.mts`, `${stem}.d.cts`]));
  }

  if (!extension || extension === ".js") {
    candidates.push(`${target}.d.ts`, `${target}/index.d.ts`);
  }

  return candidates;
}

function resolveDeclarationFile({
  directory,
  packageMetadata,
  specifier,
}: {
  directory: string;
  packageMetadata: PackageMetadata;
  specifier: string;
}): string {
  const subpath = specifier === packageMetadata.name ? "." : `.${specifier.slice(packageMetadata.name.length)}`;
  let target: string | undefined;

  if (packageMetadata.exports !== undefined) {
    const exportsValue = packageMetadata.exports;
    const exportsMap = ExportConditionsSchema.safeParse(exportsValue);
    const selected = exportsMap.success
      ? (exportsMap.data[subpath] ??
        (subpath === "." ? exportsMap.data["."] : resolveExportPattern(exportsMap.data, subpath)))
      : subpath === "."
        ? exportsValue
        : undefined;

    if (selected !== undefined) {
      target = chooseExportTarget(selected);
    }
  }

  if (target === undefined && subpath === ".") {
    target = packageMetadata.types ?? packageMetadata.typings ?? "index.d.ts";
  }

  if (target === undefined) {
    target = `${subpath.slice(2)}.d.ts`;
  }

  const candidates = getDeclarationCandidates(target);

  if (subpath === "." && packageMetadata.types !== undefined) {
    candidates.push(...getDeclarationCandidates(packageMetadata.types));
  }

  for (const candidate of candidates) {
    const file = resolve(directory, candidate);

    if (file.startsWith(`${directory}/`) && existsSync(file)) {
      return file;
    }
  }

  throw new Error(`No declaration file for ${specifier} in ${directory} (target ${target})`);
}

function resolveRelativeDeclaration(fromFile: string, request: string): string | undefined {
  const base = resolve(dirname(fromFile), request);

  for (const candidate of getDeclarationCandidates(base)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function getDeclarationRequests(content: string): Set<string> {
  const requests = new Set<string>();
  const importPattern = /(?:from|import|export)\s*["']([^"']+)["']/g;
  const importAssignmentPattern = /import\s+\w+\s*=\s*require\(["']([^"']+)["']\)/g;
  const referencePattern = /<reference\s+(?:path|types)=["']([^"']+)["']/g;

  for (const pattern of [importPattern, importAssignmentPattern, referencePattern]) {
    for (const match of content.matchAll(pattern)) {
      requests.add(match[1]);
    }
  }

  return requests;
}

function createVirtualRootUri(root: string, relativePath: string): string {
  return `${root}/${relativePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

function createVirtualUri(artifactId: string, relativePath: string): string {
  return createVirtualRootUri(`file:///__drizzle_run_types__/${artifactId}`, relativePath);
}

function createVirtualSpecifierPath(artifactId: string, specifier: string): string {
  return `file:///__drizzle_run_types__/${artifactId}/${specifier.replaceAll("/", "__")}.d.ts`;
}

function getArtifactFileName(entry: ApprovedModuleEntry): string {
  return getManifestFileName(entry.types.closureArtifact);
}

function getManifestFileName(artifactRef: TypeArtifactRef): string {
  const manifestName = artifactRef.manifestPath.split("/").at(-1);

  if (manifestName === undefined) {
    throw new Error(`Missing type manifest path for ${artifactRef.id}`);
  }

  if (/[\\/@%]/.test(manifestName)) {
    throw new Error(`Declaration manifest filename is not URL-safe: ${manifestName}`);
  }

  return manifestName;
}

function createAliasContent(relativeTarget: string): string {
  return `// Generated declaration entrypoint; do not edit.\nexport * from ${JSON.stringify(`./${relativeTarget}`)};\n`;
}

function collectClosure(directory: string, rootFile: string): Map<string, string> {
  const files = new Map<string, string>();
  const pending = [rootFile];

  while (pending.length > 0) {
    const file = pending.pop();

    if (file === undefined) {
      break;
    }

    if (files.has(file)) {
      continue;
    }

    const content = readFileSync(file, "utf8");
    files.set(file, content);

    for (const request of getDeclarationRequests(content)) {
      if (!request.startsWith(".") && !/\.d\.(?:mts|cts|ts)$/.test(request)) {
        continue;
      }

      const relativeRequest = request.startsWith(".") ? request : `./${request}`;
      const child = resolveRelativeDeclaration(file, relativeRequest);

      if (child !== undefined) {
        pending.push(child);
      }
    }
  }

  return files;
}

function resolveInstalledPackage(fromDirectory: string, packageName: string): string | undefined {
  let current = realpathSync(fromDirectory);

  while (true) {
    const candidate = resolve(current, "node_modules", packageName);

    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }

    const parent = dirname(current);

    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

function getPackageNameForSpecifier(specifier: string): string {
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/");
  }

  return specifier.split("/")[0];
}

function collectPostgresDriverDependencies(driverArtifact: DriverTypeArtifactRef): { files: DeclarationFile[] } {
  const bundledFiles: DeclarationFile[] = [];
  const packageRoots = new Map<string, { directory: string; rootFile: string; storePath: string }>();
  const pending: Array<{ packageName: string; directory: string }> = [];
  const pgTypesRoot = getPackageDirectory("@types/pg", driverArtifact.packages["@types/pg"]);
  const nodeTypesRoot = getPackageDirectory("@types/node", driverArtifact.packages["@types/node"]);

  pending.push({ packageName: "@types/pg", directory: pgTypesRoot });
  pending.push({ packageName: "@types/node", directory: nodeTypesRoot });

  while (pending.length > 0) {
    const current = pending.pop();

    if (current === undefined || packageRoots.has(current.packageName)) {
      continue;
    }

    const metadata = readPackageMetadata(current.directory);
    const rootFile = resolveDeclarationFile({
      directory: current.directory,
      packageMetadata: metadata,
      specifier: metadata.name,
    });
    const closure = collectClosure(current.directory, rootFile);
    const storePath = current.packageName === "@types/node" ? "_node_types/@types/node" : current.packageName;
    packageRoots.set(current.packageName, {
      directory: current.directory,
      rootFile,
      storePath,
    });

    for (const [file, content] of closure) {
      const relativePath = relative(current.directory, file).replaceAll("\\", "/");
      bundledFiles.push({
        uri: createVirtualRootUri(driverArtifact.root, `_dependencies/${storePath}/${relativePath}`),
        content,
      });

      for (const request of getDeclarationRequests(content)) {
        if (request.startsWith(".") || request.startsWith("node:") || builtinModules.includes(request)) {
          continue;
        }

        const dependencyName = getPackageNameForSpecifier(request);

        if (packageRoots.has(dependencyName)) {
          continue;
        }

        const dependencyDirectory = resolveInstalledPackage(current.directory, dependencyName);

        if (dependencyDirectory === undefined) {
          continue;
        }

        pending.push({ packageName: dependencyName, directory: dependencyDirectory });
      }
    }

    if (current.packageName !== "@types/node") {
      const relativeRoot = relative(current.directory, rootFile).replaceAll("\\", "/");
      const moduleTarget = relativeRoot.replace(/\.d\.(?:mts|cts|ts)$/, ".js");
      bundledFiles.push({
        uri: createVirtualRootUri(driverArtifact.root, `_dependencies/${current.packageName}/__entry__.d.ts`),
        content: createAliasContent(moduleTarget),
      });
    }
  }

  return { files: bundledFiles };
}

/**
 * Fail before writing anything when a pinned version cannot serve a specifier its package policy lists
 *
 * A package can move its subpaths across versions, as effect 4.0 stable moved `effect/unstable/sql/*` to
 * `effect/sql/*`, so every user module is checked against its own installed version.
 */
function assertPolicySpecifiersResolve(userEntries: readonly ApprovedModuleEntry[]): void {
  const problems = userEntries.flatMap((entry) => {
    const directory = getPackageDirectory(entry.packageName, entry.version);
    const metadata = readPackageMetadata(directory);

    return findUnresolvedSpecifiers({
      packageMetadata: metadata,
      specifiers: entry.allowedSpecifiers,
      resolveDeclaration: (specifier) => resolveDeclarationFile({ directory, packageMetadata: metadata, specifier }),
    }).map(({ specifier, reason }) => `- ${specifier}: ${reason}`);
  });

  if (problems.length > 0) {
    throw new Error(
      `Package policies list specifiers that a pinned version cannot serve:\n${[...new Set(problems)].join("\n")}\nList the specifiers that version exports under specifiersByVersion in packages/core/src/registry/package-policies.ts.`,
    );
  }
}

// ORM entries are target-qualified in the registry but share a package/version artifact filename, so their closures
// are merged: each target's compiler paths still expose only its approved specifiers.
function createClosureManifestText(entries: readonly ApprovedModuleEntry[]): string {
  let merged: DeclarationFile[] = [];

  for (const entry of entries) {
    const directory = getPackageDirectory(entry.packageName, entry.version);
    const metadata = readPackageMetadata(directory);
    const artifactId = `${encodeURIComponent(entry.packageName)}@${entry.version}`;
    const targets = new Map<string, string>();

    for (const specifier of entry.allowedSpecifiers) {
      targets.set(specifier, resolveDeclarationFile({ directory, packageMetadata: metadata, specifier }));
    }

    const closure = new Map<string, string>();

    for (const target of targets.values()) {
      for (const [file, content] of collectClosure(directory, target)) {
        closure.set(file, content);
      }
    }

    const files: DeclarationFile[] = [];
    const rootTarget = targets.get(entry.packageName) ?? [...targets.values()][0];

    if (rootTarget === undefined) {
      throw new Error(`No declaration targets for ${entry.packageName}@${entry.version}`);
    }
    const rootRelative = relative(directory, rootTarget).replaceAll("\\", "/");
    // The registry exposes a stable index.d.ts root even when a package uses .d.mts or .d.cts internally.
    if (rootRelative !== "index.d.ts") {
      files.push({
        uri: createVirtualUri(artifactId, "index.d.ts"),
        content: createAliasContent(rootRelative),
      });
    }

    for (const [file, content] of closure) {
      const fileRelative = relative(directory, file).replaceAll("\\", "/");
      files.push({ uri: createVirtualUri(artifactId, fileRelative), content });
    }

    for (const [specifier, target] of targets) {
      const targetRelative = relative(directory, target).replaceAll("\\", "/");
      files.push({
        uri: createVirtualSpecifierPath(artifactId, specifier),
        content: createAliasContent(targetRelative),
      });
    }

    const deduped = [...new Map(files.map((file) => [file.uri, file])).values()];
    merged = [...new Map([...merged, ...deduped].map((file) => [file.uri, file])).values()];
  }

  const [entry] = entries;

  if (entry === undefined) {
    throw new Error("Cannot build an empty declaration closure");
  }
  const manifest = {
    packageName: entry.packageName,
    version: entry.version,
    artifactId: entry.types.closureArtifact.id,
    files: merged,
  };

  return `${JSON.stringify(manifest)}\n`;
}

function createDriverManifestText(driverArtifact: DriverTypeArtifactRef): string {
  const manifest = {
    packages: driverArtifact.packages,
    artifactId: driverArtifact.id,
    files: collectPostgresDriverDependencies(driverArtifact).files,
  };

  return `${JSON.stringify(manifest)}\n`;
}

/**
 * Write one manifest into the artifact folder, from the cache when its key was built before
 *
 * A miss builds the manifest and stores it under its key, written beside the final file and renamed into place so an
 * interrupted write is never reused.
 */
function writeCachedManifest({
  fileName,
  artifactKey,
  buildManifestText,
}: {
  fileName: string;
  artifactKey: string;
  buildManifestText: () => string;
}): CacheUse {
  const cacheFolder = fileName.replace(/\.json$/, "");
  const cachePath = join(typeArtifactCacheDir, cacheFolder, `${artifactKey}.json`);
  const reused = existsSync(cachePath);
  const manifestText = reused ? readFileSync(cachePath, "utf8") : buildManifestText();

  if (!reused) {
    mkdirSync(dirname(cachePath), { recursive: true });
    const stagingPath = `${cachePath}.${process.pid}.tmp`;
    writeFileSync(stagingPath, manifestText);
    renameSync(stagingPath, cachePath);
  }

  writeFileSync(join(artifactRoot, fileName), manifestText);

  return { cacheFolder, artifactKey, reused };
}

function pruneTypeArtifactCache(cacheUses: readonly CacheUse[]): void {
  const keptKeys = new Map(cacheUses.map((use) => [use.cacheFolder, `${use.artifactKey}.json`]));

  for (const folder of readdirSync(typeArtifactCacheDir)) {
    const keptKey = keptKeys.get(folder);

    if (keptKey === undefined) {
      rmSync(join(typeArtifactCacheDir, folder), { recursive: true, force: true });
      continue;
    }

    for (const file of readdirSync(join(typeArtifactCacheDir, folder))) {
      if (file !== keptKey) {
        rmSync(join(typeArtifactCacheDir, folder, file), { force: true });
      }
    }
  }
}

function main(): void {
  const userEntries = APPROVED_MODULES.filter(
    (entry) =>
      entry.visibility === "user" && entry.allowedSpecifiers.length > 0 && entry.packageName !== "@drizzle-run/runtime",
  );
  assertPolicySpecifiersResolve(userEntries);
  mkdirSync(artifactRoot, { recursive: true });

  for (const file of readdirSync(artifactRoot, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith(".json")) {
      continue;
    }

    try {
      unlinkSync(join(artifactRoot, file.name));
    } catch (cause) {
      // Managed workspaces may mark generated files immutable. The entries below still overwrite every artifact.
      if (!(cause instanceof Error && "code" in cause && cause.code === "EPERM")) {
        throw cause;
      }
    }
  }

  const entriesByClosureId = new Map<string, ApprovedModuleEntry[]>();
  const driverArtifacts = new Map<string, DriverTypeArtifactRef>();

  for (const entry of userEntries) {
    const closureId = entry.types.closureArtifact.id;
    entriesByClosureId.set(closureId, [...(entriesByClosureId.get(closureId) ?? []), entry]);
    const driverArtifact = entry.types.driverArtifact;

    if (driverArtifact !== undefined && !driverArtifacts.has(driverArtifact.id)) {
      driverArtifacts.set(driverArtifact.id, driverArtifact);
    }
  }

  const cacheUses: CacheUse[] = [];

  for (const entries of entriesByClosureId.values()) {
    const [entry] = entries;

    if (entry === undefined) {
      throw new Error("Cannot generate an empty declaration closure");
    }
    const pinned = guestPackages.getPinnedPackage(entry.packageName, entry.version);
    // A closure only holds files of its own package, so that package's integrity covers what is read.
    const artifactKey = hashText(
      JSON.stringify({
        generatorSourceHash,
        closureArtifact: entry.types.closureArtifact,
        packageName: entry.packageName,
        version: entry.version,
        integrity: pinned.integrity,
        specifiers: entries.map((candidate) => candidate.allowedSpecifiers),
      }),
    );
    cacheUses.push(
      writeCachedManifest({
        fileName: getArtifactFileName(entry),
        artifactKey,
        buildManifestText: () => createClosureManifestText(entries),
      }),
    );
  }

  for (const driverArtifact of driverArtifacts.values()) {
    const pgTypes = guestPackages.getPinnedPackage("@types/pg", driverArtifact.packages["@types/pg"]);
    const nodeTypes = guestPackages.getPinnedPackage("@types/node", driverArtifact.packages["@types/node"]);
    // The closure also walks the packages these declarations import (pg-types, undici-types, ...) inside the
    // providing guest's install, so that guest's whole lock is part of the key.
    const artifactKey = hashText(
      JSON.stringify({
        generatorSourceHash,
        driverArtifact,
        integrities: [pgTypes.integrity, nodeTypes.integrity],
        providerLockDigests: [pgTypes.providerLockDigest, nodeTypes.providerLockDigest],
      }),
    );
    cacheUses.push(
      writeCachedManifest({
        fileName: getManifestFileName(driverArtifact),
        artifactKey,
        buildManifestText: () => createDriverManifestText(driverArtifact),
      }),
    );
  }

  pruneTypeArtifactCache(cacheUses);
  const reusedCount = cacheUses.filter((use) => use.reused).length;
  console.log(
    `Generated ${entriesByClosureId.size + driverArtifacts.size} declaration closures in ${artifactRoot}; type artifacts: ${reusedCount} reused, ${cacheUses.length - reusedCount} generated`,
  );
}

main();
