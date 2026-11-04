import type { GuideProgress } from "@drizzle-run/runtime/machines";
import * as z from "zod/mini";

import { listProjectDialects } from "../project/projects";
import { EXAMPLE_TOPICS, getExampleKind, resolveExampleSides, type OfficialExample } from "./catalog";
import { getExampleProgress } from "./progress";

export const GALLERY_DATABASES = [
  { value: "all", label: "Any database" },
  { value: "postgresql", label: "PostgreSQL" },
  { value: "sqlite", label: "SQLite" },
] as const;

export const GALLERY_KINDS = [
  { value: "all", label: "Any kind" },
  { value: "guided", label: "Guided" },
  { value: "example", label: "Examples" },
] as const;

export const GALLERY_TOPICS = [...EXAMPLE_TOPICS, "Comparisons"] as const;

export const GALLERY_PROGRESS = [
  { value: "all", label: "Any progress" },
  { value: "not_viewed", label: "Not viewed" },
  { value: "viewed", label: "Viewed" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
] as const;

const GalleryFiltersSchema = z.object({
  search: z.string(),
  topics: z.array(z.enum(GALLERY_TOPICS)),
  database: z.catch(z.enum(GALLERY_DATABASES.map(({ value }) => value)), "all"),
  kind: z.catch(z.enum(GALLERY_KINDS.map(({ value }) => value)), "all"),
  progress: z.catch(z.enum(GALLERY_PROGRESS.map(({ value }) => value)), "all"),
});

export type GalleryFilters = z.output<typeof GalleryFiltersSchema>;

/** Unknown URL filter values behave like an unselected filter. */
export function readGalleryFilters(params: URLSearchParams): GalleryFilters {
  return GalleryFiltersSchema.parse({
    search: params.get("q") ?? "",
    topics: params.getAll("topic").flatMap((topic) => {
      const parsed = z.enum(GALLERY_TOPICS).safeParse(topic);

      return parsed.success ? [parsed.data] : [];
    }),
    database: params.get("db"),
    kind: params.get("kind"),
    progress: params.get("progress"),
  });
}

export function hasGalleryFilters(filters: GalleryFilters): boolean {
  return (
    filters.search.trim() !== "" ||
    filters.topics.length > 0 ||
    filters.database !== "all" ||
    filters.kind !== "all" ||
    filters.progress !== "all"
  );
}

/** Match any selected topic, every search word, and all remaining filters. */
export function filterExamples({
  examples,
  filters,
  progress,
  views,
}: {
  examples: readonly OfficialExample[];
  filters: GalleryFilters;
  progress: Readonly<Record<string, GuideProgress>>;
  views: Readonly<Record<string, string>>;
}): OfficialExample[] {
  const words = filters.search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);

  return examples.filter((example) => {
    const topics = getGalleryTopics(example);
    const searchable = [example.title, example.description, ...topics].join(" ").toLocaleLowerCase();
    const status = getExampleProgress({ progress: progress[example.slug], viewedAt: views[example.slug] });

    return (
      words.every((word) => searchable.includes(word)) &&
      (filters.topics.length === 0 || filters.topics.some((topic) => topics.includes(topic))) &&
      (filters.database === "all" || listProjectDialects(example.manifest).includes(filters.database)) &&
      (filters.kind === "all" || getExampleKind(example) === filters.kind) &&
      (filters.progress === "all" || status === filters.progress)
    );
  });
}

/** Comparisons are derived from the two-sided example or guide, rather than its visual layout. */
export function getGalleryTopics(example: OfficialExample): (typeof GALLERY_TOPICS)[number][] {
  return resolveExampleSides(example) ? [...example.topics, "Comparisons"] : [...example.topics];
}
