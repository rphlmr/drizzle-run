import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const directory = await mkdtemp(join(tmpdir(), "drizzle-orchestration-pack-"));

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 120_000 });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`, {
      cause: result.error,
    });
  }

  return result.stdout;
}

try {
  const core = JSON.parse(
    run("pnpm", ["pack", "--json", "--pack-destination", directory], join(packageRoot, "../core")),
  );
  const packed = JSON.parse(run("pnpm", ["pack", "--json", "--pack-destination", directory], packageRoot));
  const consumer = join(directory, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "orchestration-consumer",
      private: true,
      type: "module",
    }),
  );
  await writeFile(
    join(consumer, "pnpm-workspace.yaml"),
    `overrides:\n  "@drizzle-run/core": ${JSON.stringify(core.filename)}\n`,
  );
  run(
    "pnpm",
    [
      "add",
      "--offline",
      "--ignore-scripts",
      "--config.node-linker=hoisted",
      core.filename,
      packed.filename,
      `typescript@${manifest.devDependencies.typescript}`,
      `@types/node@${manifest.devDependencies["@types/node"]}`,
    ],
    consumer,
  );

  const allowed = [
    "@drizzle-run",
    "@types",
    "@typescript",
    "es-toolkit",
    "typescript",
    "undici-types",
    "xstate",
    "zod",
  ];
  const installed = (await readdir(join(consumer, "node_modules"))).filter((name) => !name.startsWith("."));

  for (const name of installed) {
    if (!allowed.includes(name)) {
      throw new Error(`Orchestration consumer installed unexpected dependency: ${name}`);
    }
  }

  const workspacePackages = await readdir(join(consumer, "node_modules/@drizzle-run"));

  if (workspacePackages.toSorted().join(",") !== "core,orchestration") {
    throw new Error(`Orchestration consumer depends on other workspace packages: ${workspacePackages.join(", ")}`);
  }

  await copyFile(join(packageRoot, "test/node-consumer.ts"), join(consumer, "consumer.ts"));
  run(
    "pnpm",
    [
      "exec",
      "tsc",
      "consumer.ts",
      "--strict",
      "--target",
      "ES2025",
      "--lib",
      "ES2025",
      "--types",
      "node",
      "--module",
      "NodeNext",
      "--outDir",
      "output",
    ],
    consumer,
  );
  console.log(run("node", ["output/consumer.js"], consumer).trim());
  console.log(
    "Packed declarations compile without DOM; consumer installs only core, orchestration and their dependencies plus TypeScript tooling.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
