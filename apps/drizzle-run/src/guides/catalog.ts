import {
  isPairProject,
  parseGuideManifest,
  parseRichText,
  type GuideManifest,
  type GuideStep,
  type ManifestMeta,
  type RichText,
} from "@drizzle-run/core/guide";
import type { RunManifestTarget } from "@drizzle-run/core/manifest";
import type { PairManifest } from "@drizzle-run/core/pair";
import * as z from "zod/mini";

import {
  CatalogStatusSchema,
  checkVersions,
  pickShown,
  SLUG_FORMAT,
  SlugSchema,
  VersionIdSchema,
  type CatalogVersion,
} from "../official/versions";
import type { StepNoteMeta } from "../ui/run-notes";

/** A guide that starts side by side and never merges: every run runs both sides. */
export type PairGuide = GuideManifest<ManifestMeta, ManifestMeta, GuideStep, PairManifest>;

/**
 * Whether every step of the guide is side by side
 *
 * True for a guide that starts side by side and no step merges. Such a guide never writes one-version files, so only
 * a guided example walks it, never a saved project.
 */
export function isPairGuide(guide: GuideManifest): guide is PairGuide {
  return isPairProject(guide.project) && guide.steps.every((step) => step.merge === undefined);
}

/** One version of a guide, with what Drizzle Run reads from its `meta` (see `guides/meta.ts`). */
export interface GuideVersion extends CatalogVersion {
  /** Its folder under `guides/`, where its recordings live. */
  folder: string;
  /** The id of the example version it walks; absent for a guide without an example, such as the first run. */
  example?: string;
  manifest: GuideManifest;
}

/** A guide's version fields: its own id, and the slug, status and example its `meta` names. */
const GuideVersionSchema = z.object({
  id: VersionIdSchema,
  meta: z.object({
    slug: SlugSchema,
    status: CatalogStatusSchema,
    example: z.optional(VersionIdSchema),
  }),
});

/** What each version field of a guide must be, for the message. */
const GUIDE_VERSION_RULES: Readonly<Record<string, string>> = {
  id: "id must be a lowercase UUID, new for each version.",
  "meta.slug": `meta.slug must be ${SLUG_FORMAT}.`,
  "meta.status": "meta.status must be published, draft, or deleted.",
  "meta.example": "meta.example must be the id of an example version.",
};

/** Reads a guide's version fields; throws naming the guide's folder and the first field that is missing or wrong. */
export function readGuideVersion(manifest: GuideManifest, folder: string): GuideVersion {
  const parsed = GuideVersionSchema.safeParse({ id: manifest.id, meta: manifest.meta ?? {} });

  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join(".") ?? "";

    throw new Error(`guides/${folder}: ${GUIDE_VERSION_RULES[field] ?? `${field} is invalid.`}`, {
      cause: parsed.error,
    });
  }

  const { id, meta } = parsed.data;

  return {
    id,
    slug: meta.slug,
    status: meta.status,
    folder,
    ...(meta.example === undefined ? {} : { example: meta.example }),
    manifest,
  };
}

/** Builds every guide version from `guides/<folder>/guide.json`, checking ids and one live version per slug. */
export function loadGuides(sources: Readonly<Record<string, unknown>>): GuideVersion[] {
  const versions = Object.entries(sources)
    .map(([path, value]) => {
      const folder = /\/guides\/([^/]+)\/guide\.json$/.exec(path)?.[1] ?? path;
      const manifest = parseGuideManifest(value);

      for (const step of manifest.steps) {
        readStepMeta(manifest, step);
        readStepNoteMeta(manifest, step);
      }

      readGuideMark(manifest);

      return readGuideVersion(manifest, folder);
    })
    .toSorted((left, right) => left.slug.localeCompare(right.slug) || left.folder.localeCompare(right.folder));

  checkVersions("guide", versions);

  return versions;
}

let guideVersions: readonly GuideVersion[] | undefined;

/**
 * Every guide version under `guides/`, deleted ones included
 *
 * Loaded on first use, so scripts outside Vite can import this module's parsers.
 */
export function listGuideVersions(): readonly GuideVersion[] {
  guideVersions ??= loadGuides(
    import.meta.glob<unknown>("../../guides/*/guide.json", { eager: true, import: "default" }),
  );

  return guideVersions;
}

/** The guide shown at this permanent slug: the published version, or in development the draft replacing it. */
export function findGuide(slug: string): GuideManifest | undefined {
  return pickShown(listGuideVersions()).find((version) => version.slug === slug)?.manifest;
}

/** The slug of the guided first project each home starter opens. */
export const FIRST_RUN_GUIDES: Readonly<Record<RunManifestTarget["dialect"], string>> = {
  postgresql: "first-run",
  sqlite: "first-run-sqlite",
};

/** Set once a first-run guide ended or was left; the starters then create a plain project. */
export const GUIDE_SEEN_SETTING = "guide-seen";

/** Where a guide's progress is saved. A guided project keeps its own, apart from the example guide. */
export function getGuideProgressSetting(guideId: string, projectId?: string) {
  return projectId === undefined ? `guide:${guideId}` : `guide:${guideId}:${projectId}`;
}

/** What Drizzle Run shows for a step, read from its `meta` (see `guides/meta.ts`). */
export interface StepCopy {
  /** One line about the step, before it starts. */
  summary: RichText;
  /** What the step's run showed, once it ran. */
  changed: RichText | undefined;
}

function readRichMeta(guide: GuideManifest, step: GuideStep, field: string, value: unknown): RichText | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`Guide "${guide.id}" step "${step.id}": meta.${field} must be text.`);
  }

  return parseRichText(value);
}

/** Reads a step's summary and "what changed" text. Every Drizzle Run guide step has a summary. */
export function readStepMeta(guide: GuideManifest, step: GuideStep): StepCopy {
  const summary = readRichMeta(guide, step, "summary", step.meta?.summary);

  if (summary === undefined) {
    throw new Error(`Guide "${guide.id}" step "${step.id}" needs meta.summary.`);
  }

  return { summary, changed: readRichMeta(guide, step, "changed", step.meta?.changed) };
}

const MetaTextSchema = z.string().check(z.minLength(1));

const StepNoteMetaSchema = z.object({
  removed: z.optional(MetaTextSchema),
  lineNotes: z.optional(z.array(z.object({ file: MetaTextSchema, match: MetaTextSchema, text: MetaTextSchema }))),
});

/** Reads what a step tells the editor: what its edit removes and its line notes (see `guides/meta.ts`). */
export function readStepNoteMeta(guide: GuideManifest, step: GuideStep): StepNoteMeta {
  const parsed = StepNoteMetaSchema.safeParse(step.meta ?? {});

  if (!parsed.success) {
    const [field, index] = parsed.error.issues[0]?.path ?? [];
    const problem =
      field === "removed"
        ? "removed must be text"
        : index === undefined
          ? "lineNotes must be a list"
          : `lineNotes.${String(index)} must be an object with file, match and text`;

    throw new Error(`Guide "${guide.id}" step "${step.id}": meta.${problem}.`, { cause: parsed.error });
  }

  const { removed, lineNotes } = parsed.data;

  return {
    ...(removed === undefined ? {} : { removed }),
    ...(lineNotes === undefined ? {} : { lineNotes }),
  };
}

/** The title split around its highlighted words, from `meta.mark`. */
export function readGuideMark(guide: GuideManifest): { before: string; mark: string; after: string } {
  const mark = guide.meta?.mark;

  if (mark === undefined) {
    return { before: guide.title, mark: "", after: "" };
  }

  const at = typeof mark === "string" && mark !== "" ? guide.title.indexOf(mark) : -1;

  if (typeof mark !== "string" || at === -1) {
    throw new Error(`Guide "${guide.id}": meta.mark must be words of its title.`);
  }

  return { before: guide.title.slice(0, at), mark, after: guide.title.slice(at + mark.length) };
}
