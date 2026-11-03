import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Packs the companion, installs the tarball in an empty Node project, and runs its bin
 * there. `npx @drizzle-run/connect` must install this one package: core is bundled in.
 */

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const workDirectory = await mkdtemp(join(tmpdir(), "drizzle-connect-pack-"));
const cacheDirectory = join(workDirectory, "cache");

function run(command: string, args: string[], cwd: string, env = process.env) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }

  return result.stdout;
}

try {
  if (
    Object.keys(packageManifest.dependencies ?? {}).length > 0 ||
    Object.keys(packageManifest.peerDependencies ?? {}).length > 0
  ) {
    throw new Error("The companion must not declare dependencies: it bundles what it needs.");
  }

  const [packed]: { filename: string; files: { path: string }[] }[] = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", workDirectory, "--cache", cacheDirectory], packageRoot),
  );
  const packedFiles = packed.files.map((file) => file.path).toSorted();

  if (packedFiles.join(",") !== ["LICENSE", "README.md", "dist/cli.js", "package.json"].join(",")) {
    throw new Error(`The companion package holds unexpected files: ${packedFiles.join(", ")}`);
  }

  const bundle = await readFile(join(packageRoot, "dist/cli.js"), "utf8");

  if (!bundle.startsWith("#!/usr/bin/env node\n")) {
    throw new Error("dist/cli.js lost its shebang.");
  }

  if (/from\s+["']@drizzle-run\//.test(bundle)) {
    throw new Error("dist/cli.js imports a workspace package instead of bundling it.");
  }

  const consumer = join(workDirectory, "consumer");
  await mkdir(consumer, { recursive: true });
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: "connect-consumer", private: true, type: "module" }),
  );
  run(
    "npm",
    [
      "install",
      "--offline",
      "--no-audit",
      "--no-fund",
      "--cache",
      cacheDirectory,
      join(workDirectory, packed.filename),
    ],
    consumer,
  );

  const installed = [];

  for (const entry of await readdir(join(consumer, "node_modules"))) {
    if (entry.startsWith("@")) {
      for (const scoped of await readdir(join(consumer, "node_modules", entry))) {
        installed.push(`${entry}/${scoped}`);
      }
    } else if (!entry.startsWith(".")) {
      installed.push(entry);
    }
  }

  if (installed.join(",") !== packageManifest.name) {
    throw new Error(`Installing the companion brought other packages: ${installed.join(", ")}`);
  }

  const bin = join(consumer, "node_modules", ".bin", Object.keys(packageManifest.bin)[0]);
  const version = run(bin, ["--version"], consumer).trim();

  if (version !== packageManifest.version) {
    throw new Error(`The installed bin says ${version}, not ${packageManifest.version}.`);
  }

  if (!run(bin, ["--help"], consumer).includes("npx @drizzle-run/connect <code>")) {
    throw new Error("The installed bin has no usage text.");
  }

  const refused = spawnSync(bin, ["not-a-code"], {
    cwd: consumer,
    encoding: "utf8",
    env: { ...process.env, DRIZZLE_RUN_HOME: join(workDirectory, "home") },
  });

  if (refused.status !== 1 || !refused.stderr.includes("not a Drizzle Run pairing code")) {
    throw new Error(`The installed bin accepted a bad code: ${refused.stderr}`);
  }

  console.log(
    `Packed connect audit passed: ${packedFiles.length} files, bin runs in plain Node, no other package installed.`,
  );
} finally {
  await rm(workDirectory, { recursive: true, force: true });
}
