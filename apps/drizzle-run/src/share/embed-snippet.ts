import * as z from "zod/mini";

import type { PlaygroundPreview, PlaygroundTheme } from "../embed-loader/index";

export const EmbedHeightPresetIdSchema = z.enum(["compact", "standard", "tall"]);
export type EmbedHeightPresetId = z.output<typeof EmbedHeightPresetIdSchema>;

/** The Share dialog's embed heights: the playground's height once the reader clicks, with its output scrolling inside. */
export const EMBED_HEIGHT_PRESETS = [
  { id: "compact", name: "Compact", heightPx: 480 },
  { id: "standard", name: "Standard", heightPx: 600 },
  { id: "tall", name: "Tall", heightPx: 800 },
] as const satisfies readonly { id: EmbedHeightPresetId; name: string; heightPx: number }[];

export type EmbedHeightPreset = (typeof EMBED_HEIGHT_PRESETS)[number];

export const DEFAULT_EMBED_HEIGHT_PRESET_ID = "standard" satisfies EmbedHeightPresetId;

const EMBED_HEIGHT_STORAGE_KEY = "drizzle-run:embed-height";

/** Find a preset by its id. */
export function getEmbedHeightPreset(id: EmbedHeightPresetId): EmbedHeightPreset {
  const preset = EMBED_HEIGHT_PRESETS.find((candidate) => candidate.id === id);

  if (preset === undefined) {
    throw new Error(`Expected an embed height preset, but got '${id}'.`);
  }

  return preset;
}

/** The one line under the height choice: what the reader's page does with it. */
export const EMBED_HEIGHT_HINT = "The cover and the playground keep this height; output scrolls inside.";

/**
 * Read this browser's last height pick
 *
 * A writer embedding several playgrounds keeps one pick. Storage that is blocked, missing or holds anything else reads
 * as the default.
 */
export function readEmbedHeightPresetId(storage: Pick<Storage, "getItem"> | null): EmbedHeightPresetId {
  try {
    const stored = EmbedHeightPresetIdSchema.safeParse(storage?.getItem(EMBED_HEIGHT_STORAGE_KEY));

    return stored.success ? stored.data : DEFAULT_EMBED_HEIGHT_PRESET_ID;
  } catch {
    return DEFAULT_EMBED_HEIGHT_PRESET_ID;
  }
}

/** Save this browser's height pick. Storage that is full or blocked keeps the pick for this dialog only. */
export function writeEmbedHeightPresetId(storage: Pick<Storage, "setItem"> | null, id: EmbedHeightPresetId): void {
  try {
    storage?.setItem(EMBED_HEIGHT_STORAGE_KEY, id);
  } catch {
    // The pick still applies to the code shown now.
  }
}

export const EmbedThemeSchema = z.enum(["light", "dark"]) satisfies z.ZodMiniType<PlaygroundTheme>;

/** The Share dialog's embed themes, cover and playground alike. */
export const EMBED_THEMES = [
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
] as const satisfies readonly { id: PlaygroundTheme; name: string }[];

export const DEFAULT_EMBED_THEME = "dark" satisfies PlaygroundTheme;

const EMBED_THEME_STORAGE_KEY = "drizzle-run:embed-theme";

/** Read this browser's last theme pick. Storage that is blocked, missing or holds anything else reads as dark. */
export function readEmbedSnippetTheme(storage: Pick<Storage, "getItem"> | null): PlaygroundTheme {
  try {
    const stored = EmbedThemeSchema.safeParse(storage?.getItem(EMBED_THEME_STORAGE_KEY));

    return stored.success ? stored.data : DEFAULT_EMBED_THEME;
  } catch {
    return DEFAULT_EMBED_THEME;
  }
}

/** Save this browser's theme pick. Storage that is full or blocked keeps the pick for this dialog only. */
export function writeEmbedSnippetTheme(storage: Pick<Storage, "setItem"> | null, theme: PlaygroundTheme): void {
  try {
    storage?.setItem(EMBED_THEME_STORAGE_KEY, theme);
  } catch {
    // The pick still applies to the code shown now.
  }
}

/** The page's storage, or `null` where reading it throws, such as with site data blocked. */
export function getSafeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Build the embed code to paste where the playground goes
 *
 * Plain HTML; frameworks can lift the script into a component. The `preview` puts the playground's title and
 * description on a cover of the preset's height, in the picked theme. Escaping "<" keeps a "</script>" in the
 * preview from closing the snippet's script tag.
 */
export function buildEmbedSnippet({
  origin,
  snapshotId,
  preview,
  heightPreset,
  theme,
}: {
  origin: string;
  snapshotId: string;
  preview: PlaygroundPreview;
  heightPreset: EmbedHeightPreset;
  theme: PlaygroundTheme;
}): string {
  const previewLine = `\n      preview: ${JSON.stringify(preview, null, 2)
    .replaceAll("<", "\\u003c")
    .replaceAll("\n", "\n      ")},`;
  return [
    `<div></div>`,
    `<script>`,
    `  (async () => {`,
    `    const container = document.currentScript.previousElementSibling;`,
    `    const { mountPlayground } = await import("${origin}/embed/index.js");`,
    ``,
    `    mountPlayground(container, {`,
    `      snapshotId: "${snapshotId}",`,
    `      baseUrl: "${origin}",`,
    `      height: ${heightPreset.heightPx},`,
    `      theme: "${theme}",${previewLine}`,
    `    });`,
    `  })();`,
    `</script>`,
  ].join("\n");
}
