import type { GuideProgress } from "@drizzle-run/runtime/machines";
import { BookOpenIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  useLoaderData,
  useNavigate,
  useSearchParams,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunctionArgs,
} from "react-router";

import { appServicesContext } from "../app-services";
import { Button } from "../components/ui/button";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle, DrawerTrigger } from "../components/ui/drawer";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { readExampleProgress } from "../guides/guide-progress";
import { cn } from "../lib/utils";
import { formatProjectDialects } from "../project/projects";
import { SiteMain } from "../shell/site-header";
import { SiteFooter } from "../ui/site-footer";
import { PHONE_QUERY, useMediaQuery } from "../ui/use-media-query";
import { useWorkspace } from "../workspace/context";
import { listExamples, listExampleTopics } from "./catalog";
import { ExamplePreview } from "./example-preview";
import {
  filterExamples,
  GALLERY_DATABASES,
  GALLERY_KINDS,
  GALLERY_PROGRESS,
  hasGalleryFilters,
  readGalleryFilters,
} from "./gallery-filters";
import { getExampleProgress, readExampleViews } from "./progress";

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
  const phone = useMediaQuery(PHONE_QUERY);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "preview">("list");
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const examples = listExamples();
  const topics = [...listExampleTopics(examples), "Comparisons"] as const;
  const filters = readGalleryFilters(params);
  const filtered = hasGalleryFilters(filters);
  const activeFilterCount =
    filters.topics.length +
    [filters.database, filters.kind, filters.progress].filter((value) => value !== "all").length;
  const matches = filterExamples({ examples, filters, progress, views });
  const selected = matches.find((example) => example.slug === selectedSlug) ?? matches[0];
  const featured = examples.find((example) => example.featured);
  const starters = examples.filter((example) =>
    ["quick-start-postgresql", "quick-start-sqlite"].includes(example.slug),
  );
  const mobilePreview = mobileView === "preview" && selected !== undefined;
  const filterKey = params.toString();

  useEffect(() => {
    if (phone && mobilePreview) {
      backRef.current?.focus();
    }
  }, [phone, mobilePreview]);

  function updateFilters(next: URLSearchParams) {
    setSelectedSlug(null);
    setMobileView("list");
    setParams(next, { replace: true, preventScrollReset: true, flushSync: true });
  }

  function setFilter(key: "q" | "db" | "kind" | "progress", value: string) {
    const next = new URLSearchParams(params);

    if (value === "" || (key !== "q" && value === "all")) {
      next.delete(key);
    } else {
      next.set(key, value);
    }

    updateFilters(next);
  }

  function toggleTopic(topic?: (typeof topics)[number]) {
    const next = new URLSearchParams(params);
    next.delete("topic");
    const selectedTopics =
      topic === undefined
        ? []
        : filters.topics.includes(topic)
          ? filters.topics.filter((value) => value !== topic)
          : [...filters.topics, topic];

    for (const value of selectedTopics) {
      next.append("topic", value);
    }

    updateFilters(next);
  }

  function previewStarter(slug: string) {
    setParams(new URLSearchParams(), { replace: true, preventScrollReset: true });
    setSelectedSlug(slug);
    setMobileView("preview");
    requestAnimationFrame(() => {
      const list = listRef.current;
      const row = list?.querySelector<HTMLButtonElement>(`[data-example-slug="${slug}"]`);

      if (list && row) {
        list.scrollTo({
          top: Math.floor(list.scrollTop + row.getBoundingClientRect().top - list.getBoundingClientRect().top),
        });
      }
    });
  }

  function closePreview() {
    setMobileView("list");
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    });
  }

  const filterSelects = (
    <>
      <GalleryFilter
        label="Database"
        options={GALLERY_DATABASES}
        value={filters.database}
        onChange={(value) => setFilter("db", value)}
      />
      <GalleryFilter
        label="Kind"
        options={GALLERY_KINDS}
        value={filters.kind}
        onChange={(value) => setFilter("kind", value)}
      />
      <GalleryFilter
        label="Progress"
        options={GALLERY_PROGRESS}
        value={filters.progress}
        onChange={(value) => setFilter("progress", value)}
      />
    </>
  );
  const topicFilters = (
    <fieldset className="flex min-w-auto flex-wrap gap-1" aria-label="Topic">
      <Button
        size="sm"
        variant="ghost"
        className={cn(
          "rounded-md text-[12px] max-phone:min-h-touch",
          filters.topics.length === 0
            ? "bg-segment text-segment-fg hover:bg-segment hover:text-segment-fg"
            : "text-muted",
        )}
        aria-pressed={filters.topics.length === 0}
        onClick={() => toggleTopic()}
      >
        All topics
      </Button>
      {topics.map((topic) => (
        <Button
          key={topic}
          size="sm"
          variant="ghost"
          className={cn(
            "rounded-md text-[12px] max-phone:min-h-touch",
            filters.topics.includes(topic)
              ? "bg-segment text-segment-fg hover:bg-segment hover:text-segment-fg"
              : "text-muted",
          )}
          aria-pressed={filters.topics.includes(topic)}
          onClick={() => toggleTopic(topic)}
        >
          {topic}
        </Button>
      ))}
    </fieldset>
  );

  return (
    <>
      {workspace.banners}
      <main className="[container-type:size] mx-auto flex min-h-0 w-full max-w-260 min-w-0 flex-1 flex-col gap-4 overflow-hidden px-8 pt-7 pb-5 max-phone:gap-3.5 max-phone:p-4">
        <div className="flex shrink-0 flex-col gap-2">
          <h1 className="font-display text-[24px] font-semibold tracking-[-0.03em]">Examples &amp; guides</h1>
          <p className="text-[13px] text-muted max-phone:hidden [@container(height<700px)]:hidden">
            Learn a pattern. Make it yours.
          </p>
        </div>
        {featured && (
          <>
            <section
              className="flex shrink-0 items-center gap-4 rounded-lg border border-border bg-surface px-4 py-3 max-phone:hidden [@container(height<680px)]:hidden"
              aria-label="Starting points"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-text">
                  <BookOpenIcon className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h2 className="text-[13px] font-semibold">New to Drizzle?</h2>
                  <p className="truncate text-[12px] text-muted">
                    {featured.title} · {featured.guide?.steps.length} steps
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <Button
                  size="sm"
                  variant="sticker"
                  className="rounded-md"
                  aria-label="Preview guide ↓"
                  onClick={() => previewStarter(featured.slug)}
                >
                  Preview guide
                </Button>
                <div className="flex items-center gap-2 border-l border-border pl-3">
                  <span className="text-[12px] text-muted">Quick starts</span>
                  <div className="inline-flex rounded-md border border-border [&>button]:border-0 [&>button+button]:border-l [&>button:first-child]:rounded-r-none [&>button:last-child]:rounded-l-none">
                    {starters.map((example) => (
                      <Button
                        size="sm"
                        variant="outline"
                        className="rounded-md"
                        key={example.slug}
                        onClick={() => previewStarter(example.slug)}
                        aria-label={`${example.title} Preview ↓`}
                      >
                        {formatProjectDialects(example.manifest)}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            </section>
            <div
              className="hidden shrink-0 flex-wrap gap-1.5 max-phone:flex [@container(height<680px)]:flex"
              aria-label="Quick starts"
            >
              <Button size="sm" variant="outline" className="rounded-md" onClick={() => previewStarter(featured.slug)}>
                Start here
              </Button>
              {starters.map((example) => (
                <Button
                  key={example.slug}
                  size="sm"
                  variant="outline"
                  className="rounded-md"
                  aria-label={`${formatProjectDialects(example.manifest)} quick start`}
                  onClick={() => previewStarter(example.slug)}
                >
                  {formatProjectDialects(example.manifest)}
                </Button>
              ))}
            </div>
          </>
        )}
        <div className="flex shrink-0 flex-col gap-2.5">
          <div className="grid grid-cols-[minmax(180px,1fr)_auto_auto_auto] items-center gap-2 max-phone:grid-cols-[minmax(0,1fr)_auto]">
            <div className="relative min-w-0">
              <SearchIcon
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
                aria-hidden="true"
              />
              <Input
                type="search"
                aria-label="Search examples and guides"
                placeholder="Search examples, topics, or APIs…"
                className="m-0 h-9 min-h-9 rounded-md py-0 pl-9 text-[13px] max-phone:h-touch"
                value={filters.search}
                onChange={(event) => setFilter("q", event.target.value)}
              />
            </div>
            {phone ? (
              <Drawer open={filtersExpanded} onOpenChange={setFiltersExpanded}>
                <DrawerTrigger render={<Button variant="outline" className="h-touch" />}>
                  Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
                  <ChevronDownIcon className="size-3.5" aria-hidden="true" />
                </DrawerTrigger>
                <DrawerContent className="max-h-[85dvh] border border-b-0 border-border px-4 pt-4 pb-[max(16px,env(safe-area-inset-bottom))]">
                  <div className="flex items-center justify-between gap-2">
                    <DrawerTitle>Filters</DrawerTitle>
                    <DrawerClose render={<Button variant="ghost" size="sm" />}>Close</DrawerClose>
                  </div>
                  <div className="my-4 grid grid-cols-3 gap-2">{filterSelects}</div>
                  {topicFilters}
                  <div className="mt-5 flex items-center justify-between gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!filtered}
                      onClick={() => updateFilters(new URLSearchParams())}
                    >
                      Clear filters
                    </Button>
                    <DrawerClose render={<Button className="rounded-md" />}>Show {matches.length} results</DrawerClose>
                  </div>
                </DrawerContent>
              </Drawer>
            ) : (
              filterSelects
            )}
          </div>
          {!phone && topicFilters}
        </div>
        <div
          className="group/gallery grid min-h-0 flex-1 grid-cols-2 overflow-hidden rounded-lg border border-border bg-surface max-phone:grid-cols-1"
          data-preview={mobilePreview}
        >
          <section
            className="flex min-h-0 min-w-0 flex-col border-r border-border max-phone:border-0 max-phone:group-data-[preview=true]/gallery:hidden"
            aria-label="Browse examples"
          >
            <div className="flex min-h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-3.5">
              <output className="text-[12px] text-muted" aria-live="polite">
                {matches.length} {matches.length === 1 ? "example or guide" : "examples & guides"}
              </output>
              <Button
                variant="ghost"
                size="sm"
                disabled={!filtered}
                onClick={() => updateFilters(new URLSearchParams())}
              >
                Clear filters
              </Button>
            </div>
            <ul
              key={filterKey}
              className="min-h-0 flex-1 [scrollbar-gutter:stable] divide-y divide-border overflow-y-auto overscroll-contain"
              role="list"
              aria-label="Example list"
              ref={listRef}
            >
              {matches.map((example, index) => {
                const status = getExampleProgress({ progress: progress[example.slug], viewedAt: views[example.slug] });
                const label = GALLERY_PROGRESS.find(({ value }) => value === status)?.label;

                return (
                  <li key={example.slug}>
                    <button
                      type="button"
                      aria-pressed={selected?.slug === example.slug}
                      tabIndex={selected?.slug === example.slug ? 0 : -1}
                      data-example-slug={example.slug}
                      aria-controls="example-preview"
                      onKeyDown={(event) => {
                        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

                        if (event.key === "Enter" && !phone) {
                          event.preventDefault();
                          void navigate(`/examples/${example.slug}`);
                          return;
                        }

                        let nextIndex: number;
                        switch (event.key) {
                          case "ArrowDown":
                            nextIndex = Math.min(index + 1, matches.length - 1);
                            break;
                          case "ArrowUp":
                            nextIndex = Math.max(index - 1, 0);
                            break;
                          case "Home":
                            nextIndex = 0;
                            break;
                          case "End":
                            nextIndex = matches.length - 1;
                            break;
                          default:
                            return;
                        }

                        event.preventDefault();
                        const next = matches[nextIndex];
                        const button = listRef.current?.querySelector<HTMLButtonElement>(
                          `[data-example-slug="${next.slug}"]`,
                        );
                        setSelectedSlug(next.slug);
                        button?.focus({ preventScroll: true });
                        button?.scrollIntoView({ block: "nearest", inline: "nearest" });
                      }}
                      onClick={() => {
                        setSelectedSlug(example.slug);
                        setMobileView("preview");
                      }}
                      className={cn(
                        "block w-full px-4 py-3.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-text",
                        selected?.slug === example.slug && "bg-surface-2",
                      )}
                    >
                      <span className="block text-[13px]/[1.5] font-medium">{example.title}</span>
                      <span className="mt-1 block text-[12px] text-muted">
                        {example.guide ? `Guide · ${example.guide.steps.length} steps` : "Example"} ·{" "}
                        {formatProjectDialects(example.manifest)}
                      </span>
                      {status !== "not_viewed" && (
                        <span
                          className="mt-1.5 inline-block text-[11px] text-muted"
                          data-slot={example.guide ? "guide-status" : "example-status"}
                        >
                          {label}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
              {matches.length === 0 && (
                <li className="p-5 text-[14px] text-muted">No example matches these filters yet.</li>
              )}
            </ul>
          </section>
          <section
            className="flex min-h-0 min-w-0 flex-col bg-surface max-phone:hidden max-phone:group-data-[preview=true]/gallery:flex"
            id="example-preview"
            aria-label="Example preview"
          >
            <Button
              ref={backRef}
              variant="ghost"
              className="hidden self-start max-phone:inline-flex"
              onClick={closePreview}
            >
              ← Back to examples
            </Button>
            {selected ? (
              <ExamplePreview key={selected.id} example={selected} progress={progress[selected.slug]} />
            ) : (
              <p className="p-6 text-[14px] text-muted">Clear your filters to explore the library.</p>
            )}
          </section>
        </div>
      </main>
      {!phone && <SiteFooter />}
    </>
  );
}

function GalleryFilter({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative min-w-0">
      <select
        aria-label={label}
        className="h-9 w-full appearance-none rounded-md border border-border bg-surface pr-8 pl-3 text-[13px] text-text hover:bg-surface-2 focus-visible:border-accent-text focus-visible:outline-transparent max-phone:h-touch max-phone:pr-7 max-phone:pl-2 max-phone:text-[12px]"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon
        className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted"
        aria-hidden="true"
      />
    </div>
  );
}
