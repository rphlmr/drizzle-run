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

export const GALLERY_LAYOUTS = [
  { value: "all", label: "Any layout" },
  { value: "single", label: "Single" },
  { value: "side_by_side", label: "Side by side" },
] as const;

export const GALLERY_PROGRESS = [
  { value: "all", label: "Any progress" },
  { value: "not_viewed", label: "Not viewed" },
  { value: "viewed", label: "Viewed" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
] as const;

const GalleryFiltersSchema = z.object({
  search: z.string(),
  topic: z.catch(z.optional(z.enum(EXAMPLE_TOPICS)), undefined),
  database: z.catch(z.enum(GALLERY_DATABASES.map(({ value }) => value)), "all"),
  kind: z.catch(z.enum(GALLERY_KINDS.map(({ value }) => value)), "all"),
  layout: z.catch(z.enum(GALLERY_LAYOUTS.map(({ value }) => value)), "all"),
  progress: z.catch(z.enum(GALLERY_PROGRESS.map(({ value }) => value)), "all"),
});

export type GalleryFilters = z.output<typeof GalleryFiltersSchema>;

/** Unknown URL filter values behave like an unselected filter. */
export function readGalleryFilters(params: URLSearchParams): GalleryFilters {
  return GalleryFiltersSchema.parse({
    search: params.get("q") ?? "",
    topic: params.get("topic") ?? undefined,
    database: params.get("db"),
    kind: params.get("kind"),
    layout: params.get("layout"),
    progress: params.get("progress"),
  });
}

export function hasGalleryFilters(filters: GalleryFilters): boolean {
  return (
    filters.search.trim() !== "" ||
    filters.topic !== undefined ||
    filters.database !== "all" ||
    filters.kind !== "all" ||
    filters.layout !== "all" ||
    filters.progress !== "all"
  );
}

/** Every search word must match the title, description or topics; the other filters combine with AND. */
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
    const searchable = [example.title, example.description, ...example.topics].join(" ").toLocaleLowerCase();
    const layout = resolveExampleSides(example) ? "side_by_side" : "single";
    const status = getExampleProgress({ progress: progress[example.slug], viewedAt: views[example.slug] });

    return (
      words.every((word) => searchable.includes(word)) &&
      (filters.topic === undefined || example.topics.includes(filters.topic)) &&
      (filters.database === "all" || listProjectDialects(example.manifest).includes(filters.database)) &&
      (filters.kind === "all" || getExampleKind(example) === filters.kind) &&
      (filters.layout === "all" || layout === filters.layout) &&
      (filters.progress === "all" || status === filters.progress)
    );
  });
}
