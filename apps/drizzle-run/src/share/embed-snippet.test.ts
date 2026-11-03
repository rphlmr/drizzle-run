import { describe, expect, it } from "vitest";

import type { PlaygroundPreview, PlaygroundTheme } from "../embed-loader/index";
import {
  buildEmbedSnippet,
  DEFAULT_EMBED_HEIGHT_PRESET_ID,
  DEFAULT_EMBED_THEME,
  getEmbedHeightPreset,
  readEmbedHeightPresetId,
  readEmbedSnippetTheme,
  writeEmbedHeightPresetId,
  writeEmbedSnippetTheme,
  type EmbedHeightPresetId,
} from "./embed-snippet";

const origin = "https://run.example.com";
const previewFixture = {
  title: "Users",
  description: "Drizzle ORM 0.45.4 on SQLite",
} satisfies PlaygroundPreview;

function makeSnippet({
  heightPresetId = DEFAULT_EMBED_HEIGHT_PRESET_ID,
  preview = previewFixture,
  theme = DEFAULT_EMBED_THEME,
}: {
  heightPresetId?: EmbedHeightPresetId;
  preview?: PlaygroundPreview;
  theme?: PlaygroundTheme;
} = {}) {
  return buildEmbedSnippet({
    origin,
    snapshotId: "snap_123",
    preview,
    heightPreset: getEmbedHeightPreset(heightPresetId),
    theme,
  });
}

function makeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));

  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("buildEmbedSnippet", () => {
  it("should bind identical pasted copies to their own container before importing the loader", async () => {
    const snippet = makeSnippet();
    const script = snippet.slice(
      snippet.indexOf(">", snippet.indexOf("<script")) + 1,
      snippet.lastIndexOf("</script>"),
    );
    const containers = [{}, {}];
    const mounted: unknown[] = [];
    const document = {
      currentScript: { previousElementSibling: containers[0] },
      querySelector: () => containers[0],
    };
    const executable = script
      .replace(/import \{ mountPlayground \} from "[^"]+";/, "")
      .replace(/const \{ mountPlayground \} = await import\("[^"]+"\);/, "await Promise.resolve();");
    const mount = (container: unknown) => mounted.push(container);

    const firstMount = runInNewContext(executable, { document, mountPlayground: mount, Promise });
    document.currentScript.previousElementSibling = containers[1];
    const secondMount = runInNewContext(executable, { document, mountPlayground: mount, Promise });
    await Promise.all([firstMount, secondMount]);

    expect(mounted).toHaveLength(2);
    expect(mounted[0]).toBe(containers[0]);
    expect(mounted[1]).toBe(containers[1]);
  });

  it("should write the standard height, the dark theme and the preview's title and description by default", () => {
    expect(makeSnippet()).toBe(
      [
        `<div></div>`,
        `<script>`,
        `  (async () => {`,
        `    const container = document.currentScript.previousElementSibling;`,
        `    const { mountPlayground } = await import("${origin}/embed/index.js");`,
        ``,
        `    mountPlayground(container, {`,
        `      snapshotId: "snap_123",`,
        `      baseUrl: "${origin}",`,
        `      height: 600,`,
        `      theme: "dark",`,
        `      preview: {`,
        `        "title": "Users",`,
        `        "description": "Drizzle ORM 0.45.4 on SQLite"`,
        `      },`,
        `    });`,
        `  })();`,
        `</script>`,
      ].join("\n"),
    );
  });

  it("should write each preset's height as the playground's, never on the container", () => {
    expect(makeSnippet({ heightPresetId: "compact" })).toContain("\n      height: 480,\n");
    expect(makeSnippet({ heightPresetId: "tall" })).toContain("\n      height: 800,\n");
    expect(makeSnippet({ heightPresetId: "tall" })).not.toContain("style=");
  });

  it("should write the picked theme", () => {
    expect(makeSnippet({ theme: "light" })).toContain('\n      theme: "light",\n');
  });

  it("should escape closing script tags in the preview's title and description", () => {
    const snippet = makeSnippet({ preview: { title: "</script>", description: "</script>" } });

    expect(snippet).toContain(`      "title": "\\u003c/script>"`);
    expect(snippet).toContain(`        "description": "\\u003c/script>"\n      },\n    });`);
    expect(snippet).not.toContain("</script>\n    }");
  });
});

describe("readEmbedHeightPresetId", () => {
  it("should read the saved pick back", () => {
    const storage = makeStorage();

    writeEmbedHeightPresetId(storage, "tall");

    expect(readEmbedHeightPresetId(storage)).toBe("tall");
  });

  it("should fall back to standard for nothing saved, an unknown value, or storage that throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("Storage is blocked.");
      },
    };

    expect(readEmbedHeightPresetId(makeStorage())).toBe("standard");
    expect(readEmbedHeightPresetId(makeStorage({ "drizzle-run:embed-height": "huge" }))).toBe("standard");
    expect(readEmbedHeightPresetId(throwing)).toBe("standard");
    expect(readEmbedHeightPresetId(null)).toBe("standard");
  });

  it("should keep going when storage cannot save", () => {
    const full = {
      setItem: () => {
        throw new Error("Storage is full.");
      },
    };

    expect(() => writeEmbedHeightPresetId(full, "compact")).not.toThrow();
  });
});

describe("readEmbedSnippetTheme", () => {
  it("should read the saved pick back", () => {
    const storage = makeStorage();

    writeEmbedSnippetTheme(storage, "light");

    expect(readEmbedSnippetTheme(storage)).toBe("light");
  });

  it("should fall back to dark for nothing saved, an unknown value, or storage that throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("Storage is blocked.");
      },
    };

    expect(readEmbedSnippetTheme(makeStorage())).toBe("dark");
    expect(readEmbedSnippetTheme(makeStorage({ "drizzle-run:embed-theme": "sepia" }))).toBe("dark");
    expect(readEmbedSnippetTheme(throwing)).toBe("dark");
    expect(readEmbedSnippetTheme(null)).toBe("dark");
  });
});
import { runInNewContext } from "node:vm";
