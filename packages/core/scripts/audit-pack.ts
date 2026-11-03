import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as z from "zod/mini";

/**
 * Packs core, installs the tarball in an empty Node project, and imports every
 * export there. The install must bring es-toolkit and zod and nothing else: a guide editor gets
 * manifests and checks without XState, QuickJS, the databases, esbuild, or React. Only `./connect` needs xstate, an
 * optional peer, so it is imported once the consumer adds xstate itself.
 */

const ALLOWED_DEPENDENCIES = ["es-toolkit", "zod"];
const OPTIONAL_PEER = "xstate";
const PEER_EXPORT = "./connect";

const PackageManifestSchema = z.object({
  name: z.string(),
  dependencies: z.record(z.string(), z.string()),
  devDependencies: z.record(z.string(), z.string()),
  peerDependencies: z.record(z.string(), z.string()),
  peerDependenciesMeta: z.record(z.string(), z.object({ optional: z.optional(z.boolean()) })),
  exports: z.record(
    z.string(),
    z.union([z.string(), z.object({ types: z.string(), import: z.string(), default: z.string() })]),
  ),
});
const PackResultSchema = z.object({
  filename: z.string(),
  files: z.array(z.object({ path: z.string() })),
});

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageManifest = PackageManifestSchema.parse(
  JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
);
const workDirectory = await mkdtemp(join(tmpdir(), "drizzle-core-pack-"));

function run({ command, args, cwd }: { command: string; args: string[]; cwd: string }) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 300_000 });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`, { cause: result.error });
  }

  return result.stdout;
}

/** Every installed package name, scoped ones included. */
async function getInstalledPackages(nodeModules: string) {
  const names: string[] = [];

  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    if (entry.name.startsWith("@")) {
      for (const scoped of await readdir(join(nodeModules, entry.name))) {
        names.push(`${entry.name}/${scoped}`);
      }
    } else {
      names.push(entry.name);
    }
  }

  return names.toSorted();
}

try {
  const dependencyNames = Object.keys(packageManifest.dependencies ?? {});

  const peerNames = Object.keys(packageManifest.peerDependencies ?? {});

  if (
    dependencyNames.join(",") !== ALLOWED_DEPENDENCIES.join(",") ||
    peerNames.join(",") !== OPTIONAL_PEER ||
    packageManifest.peerDependenciesMeta?.[OPTIONAL_PEER]?.optional !== true
  ) {
    throw new Error(
      `Core must depend on ${ALLOWED_DEPENDENCIES.join(" and ")} only, with ${OPTIONAL_PEER} as its one optional peer, but got: ${dependencyNames.join(", ")}; peers: ${peerNames.join(", ")}`,
    );
  }

  const packed = PackResultSchema.parse(
    JSON.parse(
      run({ command: "pnpm", args: ["pack", "--json", "--pack-destination", workDirectory], cwd: packageRoot }),
    ),
  );
  const packedFiles = new Set(packed.files.map((file) => file.path));

  const moduleExports = Object.entries(packageManifest.exports).filter(
    ([exportPath]) => exportPath !== "./package.json",
  );

  if (packageManifest.exports["./package.json"] !== "./package.json") {
    throw new Error("Core must export ./package.json.");
  }

  for (const [exportPath, conditions] of moduleExports) {
    if (typeof conditions === "string") {
      throw new Error(`Core export ${exportPath} must provide types, import, and default conditions.`);
    }

    for (const target of [conditions.types, conditions.import, conditions.default]) {
      if (!packedFiles.has(target.replace(/^\.\//, ""))) {
        throw new Error(`Core export ${exportPath} points to a file absent from the package: ${target}`);
      }
    }
  }

  const consumer = join(workDirectory, "consumer");
  await mkdir(consumer, { recursive: true });
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: "core-consumer", private: true, type: "module" }),
  );
  // A frozen workspace install need not cache registry metadata for a new consumer's dependency resolution.
  // The hoisted linker lays node_modules out flat, so the check below sees every installed package.
  run({
    command: "pnpm",
    args: ["add", "--prefer-offline", "--config.node-linker=hoisted", packed.filename],
    cwd: consumer,
  });

  const installed = await getInstalledPackages(join(consumer, "node_modules"));
  const expectedPackages = [packageManifest.name, ...ALLOWED_DEPENDENCIES].toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

  if (installed.join(",") !== expectedPackages.join(",")) {
    throw new Error(`Installing core brought other packages: ${installed.join(", ")}`);
  }

  const exportPaths = moduleExports
    .map(([exportPath]) => exportPath)
    .filter((exportPath) => exportPath !== PEER_EXPORT);
  const imports = exportPaths.map(
    (exportPath, index) => `import * as module${index} from "${packageManifest.name}${exportPath.slice(1)}";`,
  );
  const script = `${imports.join("\n")}
const { parseGuideManifest } = module${exportPaths.indexOf("./guide")};
if (typeof parseGuideManifest !== "function") throw new Error("parseGuideManifest is missing.");
console.log(${exportPaths.length});
`;

  await writeFile(join(consumer, "check.mjs"), script);

  const loaded = run({ command: "node", args: ["check.mjs"], cwd: consumer }).trim();

  // The peer at the version core is built and tested with.
  run({
    command: "pnpm",
    args: [
      "add",
      "--prefer-offline",
      "--config.node-linker=hoisted",
      `${OPTIONAL_PEER}@${packageManifest.devDependencies[OPTIONAL_PEER]}`,
    ],
    cwd: consumer,
  });
  await writeFile(
    join(consumer, "check-peer.mjs"),
    `import { SecureChannel } from "${packageManifest.name}${PEER_EXPORT.slice(1)}";
if (typeof SecureChannel !== "function") throw new Error("SecureChannel is missing.");
`,
  );
  run({ command: "node", args: ["check-peer.mjs"], cwd: consumer });

  console.log(
    `Packed core audit passed: ${packedFiles.size} files, ${loaded} subpaths imported in plain Node with nothing but ${ALLOWED_DEPENDENCIES.join(" and ")} installed, and ${PEER_EXPORT} once ${OPTIONAL_PEER} was added.`,
  );
} finally {
  await rm(workDirectory, { recursive: true, force: true });
}
