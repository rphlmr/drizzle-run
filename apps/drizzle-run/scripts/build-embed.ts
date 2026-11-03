import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { build } from "esbuild";

await build({
  entryPoints: [fileURLToPath(new URL("../src/embed-loader/index.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../.cache/embed/index.js", import.meta.url)),
  bundle: true,
  format: "esm",
  target: "es2025",
  minify: true,
});

const source = await readFile(new URL("../.cache/embed/index.js", import.meta.url));
const compressedBytes = gzipSync(source, { level: 9 }).byteLength;

console.log(`Embed loader: ${source.byteLength} bytes, ${compressedBytes} bytes gzip.`);
