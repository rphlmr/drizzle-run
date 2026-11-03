// Draws every link preview image (og/cards.ts) into public/og/ as a 1200 x 630 PNG.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { listOgImages } from "../og/cards.ts";
import { createOgRenderer } from "../og/render.ts";
import { exampleSummaries } from "../worker/examples.generated.ts";

const publicDir = new URL("../public/", import.meta.url);
const renderer = await createOgRenderer();
const images = listOgImages(exampleSummaries);

await rm(new URL("og/", publicDir), { recursive: true, force: true });

for (const { path, card } of images) {
  const output = fileURLToPath(new URL(path, publicDir));

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, await renderer.renderPng(card));
}

console.log(`wrote ${images.length} link preview images to public/og/`);
