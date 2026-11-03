import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Checks typed exports, the single React peer and the runtime entry points used by the bindings.
 */

const REACT_PEERS = ["react"];

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageManifest: {
  exports: Record<string, string | { default: string; import: string; types: string }>;
  peerDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
} = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const cacheDirectory = await mkdtemp(join(tmpdir(), "drizzle-react-pack-"));

try {
  const packedResult = spawnSync("npm", ["pack", "--dry-run", "--json", "--cache", cacheDirectory], {
    cwd: packageRoot,
    encoding: "utf8",
  });

  if (packedResult.status !== 0) {
    throw new Error(`npm pack audit failed: ${packedResult.stderr || packedResult.stdout}`);
  }

  const [packedPackage]: { files: { path: string }[] }[] = JSON.parse(packedResult.stdout);

  if (!Array.isArray(packedPackage?.files)) {
    throw new Error("npm pack did not return a file inventory.");
  }

  const packedFiles = new Set(packedPackage.files.map((file) => file.path));

  if (packageManifest.exports["./package.json"] !== "./package.json") {
    throw new Error("@drizzle-run/react must export ./package.json.");
  }

  const moduleExports = Object.entries(packageManifest.exports).filter(
    ([exportPath]) => exportPath !== "./package.json",
  );

  for (const [exportPath, exportConditions] of moduleExports) {
    if (typeof exportConditions === "string") {
      throw new Error(`Export ${exportPath} needs typed import conditions.`);
    }

    if (exportConditions.default !== exportConditions.import) {
      throw new Error(`Export ${exportPath} needs a default condition matching its import condition.`);
    }

    for (const target of [exportConditions.types, exportConditions.import]) {
      if (typeof target !== "string" || !packedFiles.has(relative(packageRoot, join(packageRoot, target)))) {
        throw new Error(`Export ${exportPath} points at a file absent from the package: ${target}`);
      }
    }
  }

  for (const peer of REACT_PEERS) {
    if (packageManifest.peerDependencies?.[peer] === undefined) {
      throw new Error(`${peer} must be a peer dependency: the host brings its own copy.`);
    }

    if (packageManifest.dependencies?.[peer] !== undefined) {
      throw new Error(`${peer} must not be a dependency: two copies of React break hooks.`);
    }
  }

  for (const file of [...packedFiles].filter((path) => path.startsWith("dist/") && path.endsWith(".js"))) {
    const source = await readFile(join(packageRoot, file), "utf8");
    const runtimeImport = /from ["'](@drizzle-run\/runtime(?:\/[^"']*)?)["']/g;

    for (const [, specifier] of source.matchAll(runtimeImport)) {
      if (
        !["@drizzle-run/runtime/machines", "@drizzle-run/runtime/browser", "@drizzle-run/runtime/guides"].includes(
          specifier,
        )
      ) {
        throw new Error(`${file} imports an unexpected runtime entry point: ${specifier}`);
      }
    }
  }

  console.log(`Packed React bindings audit passed: ${packedFiles.size} files, ${moduleExports.length} typed exports.`);
} finally {
  await rm(cacheDirectory, { recursive: true, force: true });
}
