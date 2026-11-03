import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const embedDistribution = resolve(repositoryRoot, "apps/drizzle-run/.cache/embed");
// The Cloudflare Vite plugin writes the static files under dist/client and the Worker under dist/drizzle_run.
const applicationDistribution = resolve(repositoryRoot, "apps/drizzle-run/dist/client");
const embedDestination = resolve(applicationDistribution, "embed");
const embedFiles = await readdir(embedDistribution);
const requiredFiles = ["index.js", "index.d.ts", "protocol.d.ts"];

for (const file of requiredFiles) {
  if (!embedFiles.includes(file)) {
    throw new Error(`Embed build is missing required output: ${file}`);
  }
}

await mkdir(applicationDistribution, { recursive: true });
await rm(embedDestination, { recursive: true, force: true });
await cp(embedDistribution, embedDestination, { recursive: true });

console.log("Copied the embed loader and its types into apps/drizzle-run/dist/client/embed.");
