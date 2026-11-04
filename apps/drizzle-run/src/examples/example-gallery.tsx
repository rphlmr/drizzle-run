import type { GuideProgress } from "@drizzle-run/runtime/machines";
import {
  useLoaderData,
  useSearchParams,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunctionArgs,
} from "react-router";

import { appServicesContext } from "../app-services";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { readExampleProgress } from "../guides/guide-progress";
import { SiteMain } from "../shell/site-header";
import { Chip } from "../ui/chip";
import { ToggleGroup } from "../ui/toggle-group";
import { useWorkspace } from "../workspace/context";
import { listExamples, listExampleTopics } from "./catalog";
import { ExampleCard } from "./example-card";
import {
  filterExamples,
  GALLERY_DATABASES,
  GALLERY_KINDS,
  GALLERY_LAYOUTS,
  GALLERY_PROGRESS,
  hasGalleryFilters,
  readGalleryFilters,
} from "./gallery-filters";
import { readExampleViews } from "./progress";

/** Read local guide progress and visits when entering the catalog. */
export async function loadExampleGallery({ context }: LoaderFunctionArgs) {
  const { settings } = context.get(appServicesContext);
  const examples = listExamples();
  const [progress, views] = await Promise.all([
    readExampleProgress(settings, examples),
    readExampleViews(settings, examples),
  ]);

  return { progress, views };
}

/** Filter navigation reuses progress; returning from an example reads the latest visits and completion. */
export function shouldReloadExampleGallery({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (currentUrl.pathname === nextUrl.pathname) {
    return false;
  }

  return defaultShouldRevalidate;
}

/** Search and filter official examples using shareable URL parameters. */
export function ExampleGallery() {
  const { progress, views } = useLoaderData<typeof loadExampleGallery>();

  return <Gallery progress={progress} views={views} />;
}

/** The Examples page while the app reads this browser's progress. */
export function LoadingExampleGallery() {
  const workspace = useWorkspace();

  return (
    <>
      {workspace.banners}
      <SiteMain className="gap-4.5 pt-7">
        <Skeleton className="h-10 w-72" />
        <p>
          <output>Loading examples…</output>
        </p>
      </SiteMain>
    </>
  );
}

function Gallery({
  progress,
  views,
}: {
  progress: Readonly<Record<string, GuideProgress>>;
  views: Readonly<Record<string, string>>;
}) {
  const workspace = useWorkspace();
  const [params, setParams] = useSearchParams();
  const examples = listExamples();
  const topics = listExampleTopics(examples);
  const filters = readGalleryFilters(params);
  const filtered = hasGalleryFilters(filters);
  const matches = filterExamples({ examples, filters, progress, views });
  const featured = filtered ? undefined : examples.find((example) => example.featured);
  const visible = matches.filter((example) => example !== featured);

  function setFilter(key: "q" | "topic" | "db" | "kind" | "layout" | "progress", value: string | undefined) {
    const next = new URLSearchParams(params);

    if (value === undefined || value === "" || (key !== "q" && value === "all")) {
      next.delete(key);
    } else {
      next.set(key, value);
    }

    setParams(next, { replace: true, preventScrollReset: true });
  }

  return (
    <>
      {workspace.banners}
      <SiteMain className="gap-5 pt-7">
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-[28px] font-bold tracking-[-0.02em] max-phone:text-[24px]">
            Examples &amp; guides
          </h1>
          <p className="text-[14px]/[1.6] text-muted">
            Learn a pattern, run the code, then make it yours. Every example opens as an editable scratch copy. Fork it
            to keep your changes.
          </p>
        </div>
        <div className="flex flex-col gap-3">
          <Input
            type="search"
            aria-label="Search examples and guides"
            placeholder="Search examples and guides…"
            className="m-0"
            value={filters.search}
            onChange={(event) => setFilter("q", event.target.value)}
          />
          <fieldset className="flex min-w-auto flex-wrap gap-1.5" aria-label="Topic">
            <Chip pressed={filters.topic === undefined} onClick={() => setFilter("topic", undefined)}>
              All
            </Chip>
            {topics.map((topic) => (
              <Chip key={topic} pressed={filters.topic === topic} onClick={() => setFilter("topic", topic)}>
                {topic}
              </Chip>
            ))}
          </fieldset>
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup
              label="Kind"
              options={GALLERY_KINDS}
              value={filters.kind}
              onChange={(value) => setFilter("kind", value)}
              className="max-phone:w-full"
            />
            <ToggleGroup
              label="Database"
              options={GALLERY_DATABASES}
              value={filters.database}
              onChange={(value) => setFilter("db", value)}
              className="max-phone:w-full"
            />
            <ToggleGroup
              label="Layout"
              options={GALLERY_LAYOUTS}
              value={filters.layout}
              onChange={(value) => setFilter("layout", value)}
              className="max-phone:w-full"
            />
            <select
              aria-label="Progress"
              value={filters.progress}
              onChange={(event) => setFilter("progress", event.target.value)}
              className="min-h-9 rounded-md border border-border bg-surface px-3 py-1.5 text-[13px] text-text max-phone:min-h-touch"
            >
              {GALLERY_PROGRESS.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <Button
              variant="ghost"
              size="sm"
              disabled={!filtered}
              onClick={() => setParams(new URLSearchParams(), { replace: true, preventScrollReset: true })}
            >
              Clear filters
            </Button>
          </div>
          <output className="text-[12px] text-muted" aria-live="polite">
            {matches.length} {matches.length === 1 ? "example or guide" : "examples & guides"}
          </output>
        </div>
        {featured && (
          <section aria-label="Featured example">
            <ExampleCard
              example={featured}
              featured
              progress={progress[featured.slug]}
              viewedAt={views[featured.slug]}
            />
          </section>
        )}
        <div className="min-h-dvh">
          {visible.length === 0 ? (
            <p className="my-6 text-muted">No example matches these filters yet.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-surface">
              <div
                className="grid grid-cols-[minmax(0,1fr)_108px_128px_148px] items-center gap-x-6 border-b border-border bg-surface-2 px-5 py-2.5 text-[11px] font-medium text-muted max-wide:grid-cols-[minmax(0,1fr)_128px_148px] max-phone:hidden"
                aria-hidden="true"
              >
                <span>Examples &amp; guides</span>
                <span>Format</span>
                <span className="max-wide:hidden">Database</span>
                <span className="text-right">Open &amp; continue</span>
              </div>
              {/* role="list" because Safari drops list semantics from a list without bullets. */}
              <ul className="divide-y divide-border" role="list" aria-label="Example list">
                {visible.map((example) => (
                  <li key={example.slug}>
                    <ExampleCard example={example} progress={progress[example.slug]} viewedAt={views[example.slug]} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </SiteMain>
    </>
  );
}
