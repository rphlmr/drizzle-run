import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import * as z from "zod/mini";

import { runtimeAssets } from "../dist/assets/inventory.generated.js";

const DependenciesSchema = z.record(z.string(), z.string());
const ManifestSchema = z.object({
  exports: z.record(
    z.string(),
    z.union([z.string(), z.object({ types: z.string(), import: z.string(), default: z.string() })]),
  ),
  dependencies: z.optional(DependenciesSchema),
  optionalDependencies: z.optional(DependenciesSchema),
  peerDependencies: z.optional(DependenciesSchema),
  devDependencies: z.optional(DependenciesSchema),
});
const PackedPackageSchema = z.tuple([
  z.object({
    size: z.number(),
    unpackedSize: z.number(),
    files: z.array(z.object({ path: z.string() })),
  }),
]);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageManifest = ManifestSchema.parse(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")));

for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
  if (packageManifest[field]?.["@drizzle-run/orchestration"] !== undefined) {
    throw new Error(
      "The runtime must be installable without @drizzle-run/orchestration; consumers opt into workflows.",
    );
  }
}

const cacheDirectory = await mkdtemp(join(tmpdir(), "drizzle-runtime-pack-"));

try {
  const packedResult = spawnSync("npm", ["pack", "--dry-run", "--json", "--cache", cacheDirectory], {
    cwd: packageRoot,
    encoding: "utf8",
  });

  if (packedResult.status !== 0) {
    throw new Error(`npm pack audit failed: ${packedResult.stderr || packedResult.stdout}`);
  }

  const [packedPackage] = PackedPackageSchema.parse(JSON.parse(packedResult.stdout));

  const packedFiles = new Set(packedPackage.files.map((file) => file.path));
  const requiredFiles = [
    "dist/browser/index.js",
    "dist/node/index.js",
    "dist/quickjs/execution-worker.js",
    "dist/quickjs/database-worker.js",
    "dist/quickjs/sqlite3.wasm",
    "dist/quickjs/node-worker.js",
    "dist/quickjs/node-database-worker.js",
    ...runtimeAssets.map((asset) => `dist/assets/${asset.key}`),
  ];

  for (const file of requiredFiles) {
    if (!packedFiles.has(file)) {
      throw new Error(`Packed runtime is missing required file: ${file}`);
    }
  }

  if (packageManifest.exports["./package.json"] !== "./package.json") {
    throw new Error("The runtime must export ./package.json.");
  }

  const moduleExports = Object.entries(packageManifest.exports).filter(
    ([exportPath]) => exportPath !== "./package.json",
  );

  for (const [exportPath, exportConditions] of moduleExports) {
    if (typeof exportConditions === "string") {
      throw new Error(`Runtime module export ${exportPath} must declare import and types conditions.`);
    }

    if (exportConditions.default !== exportConditions.import) {
      throw new Error(`Runtime export ${exportPath} needs a default condition matching its import condition.`);
    }

    const declaration = exportConditions.types;
    if (typeof declaration !== "string") {
      throw new Error(`Runtime export ${exportPath} has no declaration path.`);
    }

    const packedDeclaration = relative(packageRoot, join(packageRoot, declaration));
    if (!packedFiles.has(packedDeclaration)) {
      throw new Error(`Runtime export ${exportPath} declaration is absent from the package: ${declaration}`);
    }
  }

  for (const asset of runtimeAssets) {
    const bytes = await readFile(join(packageRoot, "dist/assets", asset.key));
    if (bytes.byteLength !== asset.size || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
      throw new Error(`Packed runtime asset has invalid integrity: ${asset.key}`);
    }
  }

  for (const file of [...packedFiles].filter((path) => path.startsWith("dist/") && path.endsWith(".js"))) {
    const source = await readFile(join(packageRoot, file), "utf8");

    if (/from ["'](?:react|react-dom|@xstate\/react)(?:\/[^"']*)?["']/.test(source)) {
      throw new Error(`${file} imports React; the runtime must stay framework-free.`);
    }
  }

  for (const subpath of ["manifest", "catalog", "contracts"]) {
    if (Object.hasOwn(packageManifest.exports, `./${subpath}`)) {
      throw new Error(`Import ./${subpath} from @drizzle-run/core; the runtime does not own this entry.`);
    }
  }

  if (packageManifest.dependencies?.["@drizzle-run/core"] === undefined) {
    throw new Error("The runtime must depend on @drizzle-run/core, which owns its manifests and contracts.");
  }

  if (Object.hasOwn(packageManifest.exports, "./react")) {
    throw new Error("React bindings belong to @drizzle-run/react; the runtime must stay framework-free.");
  }

  const reactPackages = ["react", "react-dom", "@xstate/react"];
  const declaredPackages = [
    ...Object.keys(packageManifest.dependencies ?? {}),
    ...Object.keys(packageManifest.peerDependencies ?? {}),
  ];

  for (const reactPackage of reactPackages) {
    if (declaredPackages.includes(reactPackage)) {
      throw new Error(`The runtime declares ${reactPackage}; React belongs to @drizzle-run/react.`);
    }
  }

  // The runtime's own zod, `@types/node` and the `@libsql/client` it drives are not guest libraries here.
  const guestLibraries = ["valibot", "arktype", "typebox", "effect", "@sinclair/typebox", "@types/pg"];
  function isGuestLibrary(packageName: string): boolean {
    return (
      guestLibraries.includes(packageName) ||
      packageName.startsWith("@effect/") ||
      /^drizzle-(?:orm|kit|seed|zod|valibot|typebox|arktype)$/.test(packageName)
    );
  }

  const declaredDependencies: Array<readonly [string, string, string]> = [
    ...Object.entries(packageManifest.dependencies ?? {}).map(
      ([name, specifier]) => ["dependencies", name, specifier] as const,
    ),
    ...Object.entries(packageManifest.devDependencies ?? {}).map(
      ([name, specifier]) => ["devDependencies", name, specifier] as const,
    ),
  ];

  for (const [field, name, specifier] of declaredDependencies) {
    // An npm alias such as "drizzle-orm-v0-45-4": "npm:drizzle-orm@0.45.4" installs the package after "npm:".
    const packageName = specifier.startsWith("npm:") ? specifier.slice(4).replace(/(?<=.)@[^@]*$/, "") : name;

    // The runtime's own zod is a plain "zod" entry; an aliased zod only exists to read a guest's version.
    if (isGuestLibrary(packageName) || (packageName === "zod" && name !== "zod")) {
      throw new Error(
        `Guest library ${packageName} is in the runtime ${field} as ${name}; remove it, guests/<image-id>/package.json pins it.`,
      );
    }
  }

  console.log(
    `Packed runtime audit passed: ${packedFiles.size} files (${packedPackage.size} bytes packed, ${packedPackage.unpackedSize} unpacked), ${moduleExports.length} typed exports, and both worker entrypoints present.`,
  );
} finally {
  await rm(cacheDirectory, { recursive: true, force: true });
}
