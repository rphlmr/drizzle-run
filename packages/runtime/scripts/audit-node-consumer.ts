import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as z from "zod/mini";

const ManifestSchema = z.object({
  devDependencies: z.object({ typescript: z.string(), "@types/node": z.string() }),
});
const PackedPackageSchema = z.object({ filename: z.string() });
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), "drizzle-sdk-consumer-"));
const manifest = ManifestSchema.parse(JSON.parse(await readFile(join(root, "package.json"), "utf8")));
const keepBrowser = process.argv.includes("--keep-browser");

function run({
  command,
  args,
  cwd,
  env = process.env,
}: {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 300_000 });

  if (result.status !== 0) {
    throw new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`, { cause: result.error });
  }

  return result.stdout;
}

try {
  const packages: Record<string, string> = {};

  for (const name of ["core", "runtime"]) {
    packages[`@drizzle-run/${name}`] = PackedPackageSchema.parse(
      JSON.parse(
        run({
          command: "pnpm",
          args: ["pack", "--json", "--pack-destination", directory],
          cwd: join(root, "..", name),
        }),
      ),
    ).filename;
  }
  const consumer = join(directory, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: "sdk-consumer", private: true, type: "module" }),
  );
  await writeFile(
    join(consumer, "pnpm-workspace.yaml"),
    `overrides:\n  rolldown: 1.2.14\n${Object.entries(packages)
      .map(([name, path]) => `  ${JSON.stringify(name)}: ${JSON.stringify(path)}`)
      .join("\n")}\n`,
  );
  run({
    command: "pnpm",
    args: ["add", "--prefer-offline", "--ignore-scripts", "--config.node-linker=hoisted", ...Object.values(packages)],
    cwd: consumer,
  });
  const workspacePackages = await readdir(join(consumer, "node_modules/@drizzle-run"));

  if (workspacePackages.toSorted().join(",") !== "core,runtime") {
    throw new Error(`Standalone SDK installed unexpected workspace packages: ${workspacePackages.join(", ")}`);
  }

  for (const file of ["node-sdk.acceptance.ts", "sdk-corpus.ts", "network-disabled.cjs"]) {
    await copyFile(join(root, "test", file), join(consumer, file));
  }
  console.log(
    run({
      command: "node",
      args: ["--test", "--test-timeout=300000", "node-sdk.acceptance.ts"],
      cwd: consumer,
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${join(consumer, "network-disabled.cjs")}`,
        XDG_CACHE_HOME: join(consumer, "empty-cache"),
      },
    }),
  );
  console.log(
    "Packed core/runtime consumer passed without orchestration, outside the checkout with network access disabled.",
  );
  run({
    command: "pnpm",
    args: [
      "add",
      "--prefer-offline",
      "--ignore-scripts",
      "--save-dev",
      `typescript@${manifest.devDependencies.typescript}`,
      `@types/node@${manifest.devDependencies["@types/node"]}`,
    ],
    cwd: consumer,
  });
  await copyFile(join(root, "test/node-consumer.ts"), join(consumer, "consumer.ts"));
  run({
    command: join(consumer, "node_modules/.bin/tsc"),
    args: [
      "consumer.ts",
      "node-sdk.acceptance.ts",
      "sdk-corpus.ts",
      "--noEmit",
      "--allowImportingTsExtensions",
      "--strict",
      "--target",
      "ES2025",
      "--lib",
      "ES2025",
      "--types",
      "node",
      "--module",
      "NodeNext",
    ],
    cwd: consumer,
  });
  console.log("Packed Node declarations compile without DOM libraries.");
  if (keepBrowser) {
    run({
      command: "pnpm",
      args: ["add", "--prefer-offline", "--ignore-scripts", "--save-dev", "vite@8.3.5"],
      cwd: consumer,
    });
    const browser = join(consumer, "sdk-browser");
    await mkdir(browser);
    for (const file of ["index.html", "main.ts", "vite.config.ts"]) {
      await copyFile(join(root, "test/sdk-browser", file), join(browser, file));
    }
    run({
      command: "node",
      args: [
        "--input-type=module",
        "-e",
        'import {copyRuntimeAssets} from "@drizzle-run/runtime/assets"; await copyRuntimeAssets("sdk-browser/public/sdk-assets");',
      ],
      cwd: consumer,
    });
    console.log(`BROWSER_CONSUMER=${consumer}`);
  }
} finally {
  if (!keepBrowser) {
    await rm(directory, { recursive: true, force: true });
  }
}
