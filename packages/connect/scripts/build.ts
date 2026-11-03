import { chmod, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

/**
 * Bundles the companion into one file with `@drizzle-run/core/connect` inside, so
 * `npx @drizzle-run/connect` installs a single package with no dependencies.
 *
 * VITE_CONNECT_PACKAGE, the same variable the app's preview build reads, names where a pkg.pr.new build is published,
 * so the companion's rejoin hint runs that build again instead of the npm release.
 */

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const output = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

await rm(dist, { recursive: true, force: true });
await build({
  entryPoints: [fileURLToPath(new URL("../src/cli.ts", import.meta.url))],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  define: { __CONNECT_PACKAGE__: JSON.stringify(process.env.VITE_CONNECT_PACKAGE || null) },
  logLevel: "warning",
});
await chmod(output, 0o755);
