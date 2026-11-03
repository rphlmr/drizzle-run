import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { collectSources, loadExamples } from "../src/examples/catalog";
import { loadGuides } from "../src/guides/catalog";
import { pickShown } from "../src/official/versions";

/** Every file under `folder`, by its path relative to it. */
function listFiles(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)));
}

/** Read the official examples and guide steps with the same parsers as the app, outside Vite. */
export function readOfficialExamples() {
  const appDirectory = resolve("apps/drizzle-run");
  const guideSources: Record<string, unknown> = {};
  const metadata: Record<string, unknown> = {};
  const files: Record<string, string> = {};

  for (const guide of readdirSync(join(appDirectory, "guides"), { withFileTypes: true })) {
    const path = join(appDirectory, "guides", guide.name, "guide.json");

    if (guide.isDirectory() && existsSync(path)) {
      guideSources[`../../guides/${guide.name}/guide.json`] = JSON.parse(readFileSync(path, "utf8"));
    }
  }

  for (const example of readdirSync(join(appDirectory, "examples"), { withFileTypes: true })) {
    if (!example.isDirectory()) {
      continue;
    }

    const folder = join(appDirectory, "examples", example.name);
    metadata[`../../examples/${example.name}/example.json`] = JSON.parse(
      readFileSync(join(folder, "example.json"), "utf8"),
    );

    for (const path of listFiles(join(folder, "files"))) {
      files[`../../examples/${example.name}/files/${path}`] = readFileSync(join(folder, "files", path), "utf8");
    }

    if (existsSync(join(folder, "sides"))) {
      for (const path of listFiles(join(folder, "sides"))) {
        files[`../../examples/${example.name}/sides/${path}`] = readFileSync(join(folder, "sides", path), "utf8");
      }
    }
  }

  return pickShown(loadExamples(collectSources({ metadata, files }), loadGuides(guideSources), true), true);
}
