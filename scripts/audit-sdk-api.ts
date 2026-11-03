import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifests = new Map();
const visited = new Set();

async function manifestFor(name: string) {
  if (!manifests.has(name)) {
    const directory = join(root, "packages", name);
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));

    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (
        (peer === "xstate" || peer.startsWith("@xstate/")) &&
        manifest.peerDependenciesMeta?.[peer]?.optional !== true
      ) {
        throw new Error(`${name} requires consumers to provide ${peer}.`);
      }
    }

    manifests.set(name, { directory, manifest });
  }

  return manifests.get(name);
}

async function visitExport(name: string, entry = ".") {
  const { directory, manifest } = await manifestFor(name);
  const target = manifest.exports[entry]?.types;

  if (typeof target !== "string") {
    throw new Error(`Missing declarations for @drizzle-run/${name}/${entry}.`);
  }

  await visitFile(resolve(directory, target));
}

async function visitFile(path: string) {
  if (visited.has(path)) {
    return;
  }

  visited.add(path);
  const source = await readFile(path, "utf8");

  for (const [, specifier] of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"'\n]+)["']/g)) {
    if (specifier === "xstate" || specifier.startsWith("@xstate/")) {
      throw new Error(`Public declaration exposes ${specifier}: ${path}`);
    }

    if (specifier.startsWith(".")) {
      const target = specifier.replace(/\.(?:js|ts)$/, ".d.ts").replace(/\.(?:mjs|mts)$/, ".d.mts");
      await visitFile(resolve(dirname(path), target));
    } else if (specifier.startsWith("@drizzle-run/")) {
      const [name, ...segments] = specifier.slice("@drizzle-run/".length).split("/");
      await visitExport(name, segments.length === 0 ? "." : `./${segments.join("/")}`);
    }
  }
}

// SDK execution, orchestration and React contracts. The app's existing editor/connect integration is separate.
for (const [name, entries] of [
  ["runtime", [".", "./browser", "./node", "./assets", "./guides"]],
  ["orchestration", [".", "./run", "./comparison"]],
  ["react", ["."]],
] as const) {
  for (const entry of entries) {
    await visitExport(name, entry);
  }
}

console.log(
  `SDK declaration audit passed: ${visited.size} declaration files, no public XState types or required peers.`,
);
