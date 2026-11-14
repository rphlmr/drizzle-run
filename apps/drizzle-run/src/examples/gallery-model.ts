import type { GuideProgress } from "@drizzle-run/runtime/machines";

import { isPairManifest } from "../project/projects";
import { EXAMPLE_SECTIONS, resolveExampleSides, type OfficialExample } from "./catalog";
import { getFamilyTitle, pickFamilyVersion, type ExampleFamily, type GalleryDialect } from "./families";
import { getExampleProgress, type ExampleProgress } from "./progress";

/** What this browser remembers of the examples: guide progress and the last visit, by slug. */
export interface GalleryProgress {
  progress: Readonly<Record<string, GuideProgress>>;
  views: Readonly<Record<string, string>>;
}

/** Where a reader stands in one example version. */
export function getVersionProgress(version: OfficialExample, { progress, views }: GalleryProgress): ExampleProgress {
  return getExampleProgress({ progress: progress[version.slug], viewedAt: views[version.slug] });
}

/**
 * The 1-based step a guide resumes at: the saved step, or the first one
 *
 * Returns `undefined` for an example without a guide.
 */
export function getResumeStep(version: OfficialExample, saved: GuideProgress | undefined): number | undefined {
  if (!version.guide) {
    return undefined;
  }

  const index = saved === undefined ? -1 : version.guide.steps.findIndex((step) => step.id === saved.stepId);

  return index === -1 ? 1 : index + 1;
}

/**
 * What a side-by-side example compares, such as "SQL-like vs RQB" or "Drizzle 0.45.4 vs Drizzle 1.0.0-rc.5"
 *
 * Releases show only when the sides differ by release. Returns `undefined` for an example on one side.
 */
export function getExampleComparison(version: OfficialExample): string | undefined {
  const sides = resolveExampleSides(version);

  return sides
    ?.map((side) => {
      if (side.name === undefined) {
        return `Drizzle ${side.ormVersion}`;
      }

      return sides[0].ormVersion === sides[1].ormVersion ? side.name : `${side.name} (${side.ormVersion})`;
    })
    .join(" vs ");
}

/** What opening the example does for this reader: open it, start, continue or revisit its guide. */
export function getExampleCallToAction(version: OfficialExample, saved: GuideProgress | undefined): string {
  if (!version.guide) {
    return "Open example";
  }

  if (saved?.finished) {
    return "Revisit guide";
  }

  return saved ? `Continue at step ${getResumeStep(version, saved)}` : "Start guide";
}

/** One example a reader started and did not finish, for "Pick up where you left off". */
export interface PickUpEntry {
  family: ExampleFamily;
  version: OfficialExample;
  status: Exclude<ExampleProgress, "not_viewed" | "completed">;
  viewedAt: string | undefined;
}

/**
 * The examples to pick up again: guides in progress and examples opened, newest visit first
 *
 * Every version counts, whatever the reader's database, since progress belongs to the version they opened. Finished
 * guides are left out.
 */
export function listPickUp(families: readonly ExampleFamily[], saved: GalleryProgress, limit = 3): PickUpEntry[] {
  const entries: PickUpEntry[] = [];

  for (const family of families) {
    for (const version of family.versions) {
      const status = getVersionProgress(version, saved);

      if (status === "viewed" || status === "in_progress") {
        entries.push({ family, version, status, viewedAt: saved.views[version.slug] });
      }
    }
  }

  return entries.toSorted((left, right) => (right.viewedAt ?? "").localeCompare(left.viewedAt ?? "")).slice(0, limit);
}

/** A guide step whose title matches a search. */
export interface StepMatch {
  family: ExampleFamily;
  version: OfficialExample;
  /** 1-based, as the example page's `step` parameter takes it. */
  step: number;
  title: string;
}

/** A line of an example's code that matches a search. */
export interface CodeMatch {
  family: ExampleFamily;
  version: OfficialExample;
  file: string;
  line: string;
}

/** What a gallery search found, by where it matched. Each family shows in the first group it matches. */
export interface GallerySearchResults {
  families: ExampleFamily[];
  steps: StepMatch[];
  code: CodeMatch[];
}

const MAX_LINE = 120;

function toWords(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

function hasEveryWord(text: string, words: readonly string[]): boolean {
  const haystack = text.toLowerCase();

  return words.every((word) => haystack.includes(word));
}

/** Every file a version runs, shared files first, by path. */
function listVersionFiles(version: OfficialExample): [string, string][] {
  const { manifest } = version;

  return isPairManifest(manifest)
    ? [...Object.entries(manifest.files), ...manifest.sides.flatMap((side) => Object.entries(side.files))]
    : Object.entries(manifest.files);
}

/**
 * Search the gallery on the reader's database
 *
 * A family matches by title, description, topics or section when it holds every word of the query; else by a guide
 * step title holding every word; else by a line of its code holding the whole query, such as `leftJoin(` or
 * `jsonb_set`. Each family is searched in the version the reader would open.
 */
export function searchGallery(
  families: readonly ExampleFamily[],
  query: string,
  dialect: GalleryDialect,
): GallerySearchResults {
  const words = toWords(query);
  const phrase = query.trim().toLowerCase();
  const results: GallerySearchResults = { families: [], steps: [], code: [] };

  if (words.length === 0) {
    return results;
  }

  for (const family of families) {
    const version = pickFamilyVersion(family, dialect);
    const section = EXAMPLE_SECTIONS.find(({ id }) => id === family.section)?.label ?? "";
    const text = [getFamilyTitle(family, version), version.description, section, ...version.topics].join(" ");

    if (hasEveryWord(text, words)) {
      results.families.push(family);
      continue;
    }

    const stepIndex = version.guide?.steps.findIndex((step) => hasEveryWord(step.title, words)) ?? -1;

    if (version.guide && stepIndex !== -1) {
      results.steps.push({ family, version, step: stepIndex + 1, title: version.guide.steps[stepIndex].title });
      continue;
    }

    for (const [file, content] of listVersionFiles(version)) {
      const line = content.split("\n").find((item) => item.toLowerCase().includes(phrase));

      if (line !== undefined) {
        results.code.push({ family, version, file, line: line.trim().slice(0, MAX_LINE) });
        break;
      }
    }
  }

  return results;
}
