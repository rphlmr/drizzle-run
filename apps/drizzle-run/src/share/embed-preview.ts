import { DIALECTS } from "@drizzle-run/core/catalog";
import type { RunManifest } from "@drizzle-run/core/manifest";

import type { PlaygroundPreview, PlaygroundRuntime } from "../embed-loader/index";
import { EMBED_PREVIEW_LIMITS } from "../embed-loader/protocol";
import { isPairManifest, type ProjectRecord } from "../project/projects";

/** Trim text and cut it to `maxLength` characters, ending in "…" when cut. */
function toPreviewText(text: string, maxLength: number): string {
  const trimmed = text.trim();

  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

/** What one side runs on, named when it has a name. */
function toRuntime(side: Pick<RunManifest, "dependencies" | "target"> & { name?: string }): PlaygroundRuntime {
  return {
    ...(side.name === undefined || side.name.trim() === ""
      ? {}
      : { name: toPreviewText(side.name, EMBED_PREVIEW_LIMITS.runtimeTextLength) }),
    drizzleOrm: toPreviewText(side.dependencies["drizzle-orm"], EMBED_PREVIEW_LIMITS.runtimeTextLength),
    database: toPreviewText(DIALECTS[side.target.dialect].label, EMBED_PREVIEW_LIMITS.runtimeTextLength),
  };
}

/** What each side of a project runs on: one for a one-version project, both, with their names, for a side-by-side one. */
function describeRuntime(manifest: ProjectRecord["manifest"]): NonNullable<PlaygroundPreview["runtime"]> {
  if (!isPairManifest(manifest)) {
    return [toRuntime(manifest)];
  }

  const [first, second] = manifest.sides;

  return [toRuntime(first), toRuntime(second)];
}

/**
 * Build what a share's embed cover shows before the click
 *
 * The project's name as the title, the description its author wrote when there is one, what it runs on when the
 * manifest is known, and the author's GitHub login when they are signed in. Each text is cut to the loader's limits, so an embed never throws on
 * the reader's page.
 */
export function buildEmbedPreview({
  name,
  description = "",
  manifest,
  author,
}: Pick<ProjectRecord, "name"> & {
  manifest?: ProjectRecord["manifest"];
  description?: string;
  author?: string;
}): PlaygroundPreview {
  const trimmedDescription = description.trim();

  return {
    title: toPreviewText(name, EMBED_PREVIEW_LIMITS.titleLength),
    ...(trimmedDescription === ""
      ? {}
      : { description: toPreviewText(trimmedDescription, EMBED_PREVIEW_LIMITS.descriptionLength) }),
    ...(manifest === undefined ? {} : { runtime: describeRuntime(manifest) }),
    ...(author === undefined ? {} : { author }),
  };
}
