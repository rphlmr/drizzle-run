import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Deletes everything .gitignore covers (node_modules, builds, .cache, .wrangler, test reports), so the checkout
// looks freshly cloned. Local settings and secrets stay. Run `pnpm install` afterwards.
// Uses only Node built-ins: it deletes the node_modules it would otherwise import from.

const rootDir = fileURLToPath(new URL("..", import.meta.url));

// Ignored, but not generated: agent settings and worktrees, and local secrets.
const keptPaths = [/^\.claude\//, /^\.superpowers\//, /(?:^|\/)\.dev\.vars/, /(?:^|\/)\.env/];

// `--directory` lists an ignored folder once instead of every file in it.
const ignoredPaths = execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], {
  cwd: rootDir,
  encoding: "utf8",
})
  .split("\n")
  .filter((path) => path !== "" && !keptPaths.some((kept) => kept.test(path)));

if (ignoredPaths.length === 0) {
  console.log("Nothing to clean.");
  process.exit(0);
}

await Promise.all(ignoredPaths.map((path) => rm(join(rootDir, path), { recursive: true, force: true })));

for (const path of ignoredPaths) {
  console.log(`Deleted ${path}`);
}

console.log("Run `pnpm install` to restore dependencies.");
