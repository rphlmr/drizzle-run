import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";

import { initWasm, Resvg } from "@resvg/resvg-wasm";
import satori from "satori";

import type { OgCard } from "./cards.ts";
import { layoutOgCard, ogFontFamilies, ogImageSize } from "./layout.ts";

const require = createRequire(import.meta.url);

// The app's own fonts. Satori reads WOFF but not WOFF2.
const fontFiles = [
  {
    name: ogFontFamilies.display,
    weight: 700,
    file: "@fontsource/bricolage-grotesque/files/bricolage-grotesque-latin-700-normal.woff",
  },
  { name: ogFontFamilies.sans, weight: 400, file: "@fontsource/geist/files/geist-latin-400-normal.woff" },
  { name: ogFontFamilies.sans, weight: 500, file: "@fontsource/geist/files/geist-latin-500-normal.woff" },
  {
    name: ogFontFamilies.mono,
    weight: 400,
    file: "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff",
  },
] as const;

/** A card renderer with its fonts and WebAssembly loaded once. */
export interface OgRenderer {
  renderSvg(card: OgCard): Promise<string>;
  renderPng(card: OgCard): Promise<Uint8Array>;
}

/** Create a card renderer: loads the fonts without kerning, and starts resvg. */
export async function createOgRenderer(): Promise<OgRenderer> {
  const [fonts] = await Promise.all([
    Promise.all(
      fontFiles.map(async ({ name, weight, file }) => ({
        name,
        weight,
        data: toUnkernedFont(await readFile(require.resolve(file))),
      })),
    ),
    initWasm(await readFile(require.resolve("@resvg/resvg-wasm/index_bg.wasm"))),
  ]);

  async function renderSvg(card: OgCard): Promise<string> {
    return satori(layoutOgCard(card), { ...ogImageSize, fonts });
  }

  return {
    renderSvg,
    async renderPng(card) {
      const rendered = new Resvg(await renderSvg(card)).render();

      try {
        return rendered.asPng();
      } finally {
        rendered.free();
      }
    },
  };
}

/**
 * Unpack a WOFF 1.0 font into a plain OpenType font without kerning
 *
 * Satori places each word by its unkerned width but draws it kerned, so a word with many kerning pairs ("different")
 * was followed by a wide gap. The GPOS `kern` feature is renamed so no shaper applies it, and the legacy `kern` table,
 * which readers fall back to, is dropped.
 */
export function toUnkernedFont(woff: Buffer): Buffer {
  if (woff.toString("latin1", 0, 4) !== "wOFF") {
    throw new Error(`Expected a WOFF 1.0 file, but got signature '${woff.toString("latin1", 0, 4)}'`);
  }

  const flavor = woff.readUInt32BE(4);
  const tables: { tag: string; checksum: number; data: Buffer }[] = [];

  for (let index = 0; index < woff.readUInt16BE(12); index++) {
    const entry = 44 + index * 20;
    const tag = woff.toString("latin1", entry, entry + 4);
    const offset = woff.readUInt32BE(entry + 4);
    const compressedLength = woff.readUInt32BE(entry + 8);
    const length = woff.readUInt32BE(entry + 12);
    const stored = woff.subarray(offset, offset + compressedLength);
    const data = compressedLength < length ? inflateSync(stored) : Buffer.from(stored);

    if (tag !== "kern") {
      tables.push({
        tag,
        checksum: woff.readUInt32BE(entry + 16),
        data: tag === "GPOS" ? disableKerningFeature(data) : data,
      });
    }
  }

  return packFont(flavor, tables);
}

function disableKerningFeature(gpos: Buffer): Buffer {
  const table = Buffer.from(gpos);
  const featureList = table.readUInt16BE(6);

  for (let index = 0; index < table.readUInt16BE(featureList); index++) {
    const record = featureList + 2 + index * 6;

    if (table.toString("latin1", record, record + 4) === "kern") {
      table.write("xkrn", record, "latin1");
    }
  }

  return table;
}

/** Packs tables into an OpenType font, each padded to four bytes, in the order given. */
function packFont(flavor: number, tables: readonly { tag: string; checksum: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(12 + tables.length * 16);
  const searchPower = 2 ** Math.floor(Math.log2(tables.length));
  const bodies: Buffer[] = [];
  let offset = header.length;

  header.writeUInt32BE(flavor, 0);
  header.writeUInt16BE(tables.length, 4);
  header.writeUInt16BE(searchPower * 16, 6);
  header.writeUInt16BE(Math.log2(searchPower), 8);
  header.writeUInt16BE(tables.length * 16 - searchPower * 16, 10);

  for (const [index, { tag, checksum, data }] of tables.entries()) {
    const entry = 12 + index * 16;
    const padded = Buffer.alloc(Math.ceil(data.length / 4) * 4);

    data.copy(padded);
    header.write(tag, entry, "latin1");
    header.writeUInt32BE(checksum, entry + 4);
    header.writeUInt32BE(offset, entry + 8);
    header.writeUInt32BE(data.length, entry + 12);
    bodies.push(padded);
    offset += padded.length;
  }

  return Buffer.concat([header, ...bodies]);
}
