// Compiles the `guide` export of each guides/<folder>/guide.ts to guide.json. With --check, fails when a guide.json is stale.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { parseGuideManifest } from "@drizzle-run/core/guide";

const check = process.argv.includes("--check");
const root = new URL("../guides/", import.meta.url);
const stale = [];

for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue;
  }

  const folder = new URL(`${entry.name}/`, root);
  const source = await import(pathToFileURL(new URL("guide.ts", folder).pathname).href);
  const manifest = parseGuideManifest(source.guide);

  const output = new URL("guide.json", folder);
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  const current = await readFile(output, "utf8").catch(() => undefined);

  if (current === json) {
    continue;
  }

  if (check) {
    stale.push(`guides/${entry.name}/guide.json`);
    continue;
  }

  await writeFile(output, json);
  console.log(`wrote guides/${entry.name}/guide.json`);
}

if (stale.length > 0) {
  console.error(`Stale guide output, run \`pnpm --filter @drizzle-run/app generate:guides\`:\n${stale.join("\n")}`);
  process.exit(1);
}
