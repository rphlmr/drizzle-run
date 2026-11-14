import { SearchIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  Link,
  NavigationType,
  useLoaderData,
  useLocation,
  useNavigationType,
  useSearchParams,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import * as z from "zod/mini";

import { appServicesContext, useAppServices } from "../app-services";
import { Button } from "../components/ui/button";
import { Drawer, DrawerContent, DrawerTitle } from "../components/ui/drawer";
import { Skeleton } from "../components/ui/skeleton";
import { readExampleProgress } from "../guides/guide-progress";
import { cn } from "../lib/utils";
import { SiteMain } from "../shell/site-header";
import { ToggleGroup } from "../ui/toggle-group";
import { PHONE_QUERY, useMediaQuery } from "../ui/use-media-query";
import { useWorkspace } from "../workspace/context";
import { DOCS_ORIGIN, EXAMPLE_SECTIONS, listExamples, type ExampleSectionId } from "./catalog";
import { EXAMPLE_COLLECTIONS, findExampleCollection } from "./collections";
import { ExampleCard } from "./example-card";
import { ExamplePreview } from "./example-preview";
import {
  familyRuns,
  findExampleFamily,
  GALLERY_DIALECTS,
  getFamilyTitle,
  getVersionDialectLabel,
  listExampleFamilies,
  pickFamilyVersion,
  type ExampleFamily,
  type GalleryDialect,
} from "./families";
import { getVersionProgress, listPickUp, searchGallery, type GalleryProgress } from "./gallery-model";
import { readExampleViews } from "./progress";

/** The database the gallery opens examples on, remembered in this browser. */
export const GALLERY_DIALECT_SETTING = "examples-dialect";

const GalleryDialectSchema = z.enum(GALLERY_DIALECTS.map(({ value }) => value));
const OVERVIEW_PER_SECTION = 3;
const SCROLL_KEY = "examples-scroll:";

/** Read local guide progress, visits and the reader's database when entering the gallery. */
export async function loadExampleGallery({ context }: LoaderFunctionArgs) {
  const { settings } = context.get(appServicesContext);
  const examples = listExamples();
  const [progress, views, dialect] = await Promise.all([
    readExampleProgress(settings, examples),
    readExampleViews(settings, examples),
    settings.readSetting(GALLERY_DIALECT_SETTING).catch(() => undefined),
  ]);
  const parsed = GalleryDialectSchema.safeParse(dialect);

  return {
    progress,
    views,
    dialect: parsed.success ? parsed.data : ("postgresql" as GalleryDialect),
  };
}

/** Moving between views reuses progress; returning from an example reads the latest visits and completion. */
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

/** What the gallery shows, read from its address. */
type GalleryView =
  | { kind: "overview" }
  | { kind: "section"; section: ExampleSectionId }
  | { kind: "collection"; id: string }
  | { kind: "search"; query: string };

function readView(params: URLSearchParams): GalleryView {
  const query = params.get("q") ?? "";

  if (query.trim() !== "") {
    return { kind: "search", query };
  }

  const section = EXAMPLE_SECTIONS.find(({ id }) => id === params.get("section"));

  if (section) {
    return { kind: "section", section: section.id };
  }

  const collection = findExampleCollection(params.get("collection") ?? "");

  return collection ? { kind: "collection", id: collection.id } : { kind: "overview" };
}

let documentRendered = false;

/**
 * Whether this is the first render of a document the reader opened by a link or the address bar
 *
 * The router reports such a load as a POP, under a key that every load of the tab shares, so it must not restore a
 * position saved by an earlier visit. A reload or a Back into the page still restores it.
 */
function isFreshDocument(): boolean {
  if (documentRendered) {
    return false;
  }

  documentRendered = true;
  const [entry] = performance.getEntriesByType("navigation");

  return entry instanceof PerformanceNavigationTiming && entry.type === "navigate";
}

/**
 * Keep the gallery's scroll position for each history entry, and put it back on Back
 *
 * The site scrolls its `main` element rather than the window, so the router's own restoration does not reach it.
 */
function useGalleryScroll(anchor: React.RefObject<HTMLElement | null>, viewKey: string) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const storageKey = `${SCROLL_KEY}${location.key}`;
  const firstView = useRef(true);

  useLayoutEffect(() => {
    const main = anchor.current?.closest("main");

    if (!main) {
      return;
    }

    if (firstView.current) {
      firstView.current = false;
      const fresh = isFreshDocument();

      if (navigationType === NavigationType.Pop && !fresh) {
        try {
          const saved = Number(sessionStorage.getItem(storageKey));

          if (Number.isFinite(saved)) {
            main.scrollTop = saved;
          }
        } catch {
          // Without session storage the page opens at the top.
        }
      }
    } else {
      main.scrollTop = 0;
    }

    let frame = 0;
    const save = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        try {
          sessionStorage.setItem(storageKey, String(Math.round(main.scrollTop)));
        } catch {
          // Without session storage, Back opens the gallery at the top.
        }
      });
    };

    main.addEventListener("scroll", save, { passive: true });

    return () => {
      cancelAnimationFrame(frame);
      main.removeEventListener("scroll", save);
    };
    // A new view scrolls to the top; typing a search keeps the same view kind and position.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `navigationType` only matters for the first view.
  }, [anchor, storageKey, viewKey]);
}

/** Search, sections and collections of the official examples, with a quick look at each before opening it. */
export function ExampleGallery() {
  const loaded = useLoaderData<typeof loadExampleGallery>();
  const { settings } = useAppServices();
  const workspace = useWorkspace();
  const phone = useMediaQuery(PHONE_QUERY);
  const [params, setParams] = useSearchParams();
  const [dialect, setDialect] = useState<GalleryDialect>(loaded.dialect);
  const [quickLook, setQuickLook] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const quickLookClose = useRef<HTMLButtonElement>(null);
  const view = readView(params);
  const families = listExampleFamilies();
  const saved: GalleryProgress = loaded;
  const viewKey =
    view.kind === "search"
      ? "search"
      : view.kind === "section"
        ? view.section
        : view.kind === "collection"
          ? view.id
          : "overview";

  useGalleryScroll(anchor, viewKey);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;

      if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !target?.closest("input, textarea, select, [contenteditable='true']")
      ) {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };

    window.addEventListener("keydown", focusSearch);

    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const changeDialect = (next: GalleryDialect) => {
    setDialect(next);
    void settings.writeSetting(GALLERY_DIALECT_SETTING, next).catch(() => undefined);
  };

  const setSearch = (query: string) => {
    const next = new URLSearchParams();

    if (query !== "") {
      next.set("q", query);
    }

    setParams(next, { replace: true, preventScrollReset: true });
  };

  const card = (family: ExampleFamily, extra: Partial<Parameters<typeof ExampleCard>[0]> = {}) => {
    const version = extra.version ?? pickFamilyVersion(family, dialect);
    const onlyOn = familyRuns(family, dialect)
      ? undefined
      : GALLERY_DIALECTS.find(({ value }) => value !== dialect)?.label;

    return (
      <ExampleCard
        key={version.slug}
        version={version}
        title={getFamilyTitle(family, version)}
        status={getVersionProgress(version, saved)}
        progress={saved.progress[version.slug]}
        onlyOn={onlyOn}
        onQuickLook={() => setQuickLook(version.slug)}
        {...extra}
      />
    );
  };

  const sectionFamilies = (section: ExampleSectionId) => families.filter((family) => family.section === section);

  let content: ReactNode;

  if (view.kind === "search") {
    const results = searchGallery(families, view.query, dialect);
    const count = results.families.length + results.steps.length + results.code.length;

    content =
      count === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-card-border bg-surface p-6 text-[13px]">
          <p className="font-semibold">Nothing for “{view.query.trim()}” yet.</p>
          <p className="text-muted">No example uses it so far.</p>
          <p className="flex flex-wrap gap-x-3 gap-y-1">
            <a href={DOCS_ORIGIN} target="_blank" rel="noreferrer" className="text-accent-text underline">
              Browse the Drizzle docs ↗
            </a>
            <a
              href="https://github.com/rphlmr/drizzle-run/issues/new/choose"
              target="_blank"
              rel="noreferrer"
              className="text-accent-text underline"
            >
              Request an example ↗
            </a>
          </p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => setSearch("")}>
            Clear search
          </Button>
        </div>
      ) : (
        <>
          <output className="text-[13px] text-muted" aria-live="polite">
            {count} {count === 1 ? "result" : "results"} for “{view.query.trim()}”
          </output>
          {results.families.length > 0 && (
            <GallerySection title="Titles and descriptions">
              <CardGrid label={"Matching examples"}>{results.families.map((family) => card(family))}</CardGrid>
            </GallerySection>
          )}
          {results.steps.length > 0 && (
            <GallerySection title="Guide steps">
              <CardGrid label={"Matching guide steps"}>
                {results.steps.map(({ family, version, step, title }) =>
                  card(family, {
                    version,
                    href: `/examples/${version.slug}?step=${step}`,
                    detail: (
                      <p className="text-[12.5px]/[1.5] text-soft">
                        Step {step} · {title}
                      </p>
                    ),
                  }),
                )}
              </CardGrid>
            </GallerySection>
          )}
          {results.code.length > 0 && (
            <GallerySection title="Used in code">
              <CardGrid label={"Matching code"}>
                {results.code.map(({ family, version, file, line }) =>
                  card(family, {
                    version,
                    detail: (
                      <p className="flex min-w-0 flex-col gap-0.5 text-[12px] text-soft">
                        <span className="text-[11px] text-muted">{file}</span>
                        <code className="truncate font-mono text-[11.5px]">{line}</code>
                      </p>
                    ),
                  }),
                )}
              </CardGrid>
            </GallerySection>
          )}
        </>
      );
  } else if (view.kind === "section") {
    const section = EXAMPLE_SECTIONS.find(({ id }) => id === view.section) ?? EXAMPLE_SECTIONS[0];

    content = (
      <>
        <Breadcrumb current={section.label} />
        <h2 className="font-display text-[20px] font-semibold tracking-[-0.02em]">{section.label}</h2>
        <CardGrid label={section.label}>{sectionFamilies(section.id).map((family) => card(family))}</CardGrid>
      </>
    );
  } else if (view.kind === "collection") {
    const collection = findExampleCollection(view.id) ?? EXAMPLE_COLLECTIONS[0];
    const members = collection.families.flatMap((key) => findExampleFamily(key, families) ?? []);

    content = (
      <>
        <Breadcrumb current="Collections" />
        <div>
          <p className="text-[11px] font-medium tracking-[0.02em] text-muted uppercase">
            {collection.kind} · {members.length} in order
          </p>
          <h2 className="font-display text-[20px] font-semibold tracking-[-0.02em]">{collection.title}</h2>
        </div>
        <ol className="flex flex-col gap-2.5" aria-label={collection.title}>
          {members.map((family, index) => {
            const version = pickFamilyVersion(family, dialect);
            const done = getVersionProgress(version, saved) === "completed";

            return (
              <li key={family.key} className="grid grid-cols-[24px_minmax(0,1fr)] items-start gap-2.5">
                <span
                  className={cn(
                    "mt-3.5 flex size-6 items-center justify-center rounded-full border border-card-border bg-surface text-[11px] font-semibold text-muted",
                    done && "border-ok bg-ok text-surface",
                  )}
                  aria-hidden="true"
                >
                  {done ? "✓" : index + 1}
                </span>
                {card(family)}
              </li>
            );
          })}
        </ol>
      </>
    );
  } else {
    const pickUp = listPickUp(families, saved);

    content = (
      <>
        {pickUp.length > 0 && (
          <GallerySection title="Pick up where you left off">
            <CardGrid label={"Pick up where you left off"}>
              {pickUp.map(({ family, version }) => card(family, { version }))}
            </CardGrid>
          </GallerySection>
        )}
        <GallerySection title="Collections" note="Short sets, in order">
          <CardGrid label={"Collections"}>
            {EXAMPLE_COLLECTIONS.map((collection) => {
              const members = collection.families.flatMap((key) => findExampleFamily(key, families) ?? []);
              const done = members.filter(
                (family) => getVersionProgress(pickFamilyVersion(family, dialect), saved) === "completed",
              ).length;

              return (
                <article
                  key={collection.id}
                  className="relative flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-surface p-3.5 transition-[border-color,box-shadow] hover:border-card-border hover:shadow-sticker-card has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-accent-text"
                >
                  <span className="text-[11px] font-medium tracking-[0.02em] text-muted uppercase">
                    {collection.kind} · {members.length}
                  </span>
                  <h3 className="text-[14px]/[1.35] font-semibold">
                    <Link
                      to={`?collection=${collection.id}`}
                      className="text-text no-underline after:absolute after:inset-0 after:rounded-lg"
                    >
                      {collection.title}
                    </Link>
                  </h3>
                  <p className="line-clamp-2 text-[12.5px]/[1.5] text-soft">
                    {members.map((family) => getFamilyTitle(family, pickFamilyVersion(family, dialect))).join(" → ")}
                  </p>
                  {done > 0 && (
                    <span className="mt-auto w-fit rounded-[4px] bg-ok-bg px-1.75 py-px text-[11px] font-semibold text-ok">
                      ✓ {done} of {members.length}
                    </span>
                  )}
                </article>
              );
            })}
          </CardGrid>
        </GallerySection>
        {EXAMPLE_SECTIONS.map((section) => {
          const items = sectionFamilies(section.id);

          return (
            items.length > 0 && (
              <GallerySection
                key={section.id}
                title={section.label}
                count={items.length}
                more={
                  items.length > OVERVIEW_PER_SECTION ? (
                    <Link
                      to={`?section=${section.id}`}
                      className="text-[13px] font-medium text-text no-underline hover:underline"
                    >
                      See all {items.length} ›
                    </Link>
                  ) : undefined
                }
              >
                <CardGrid label={section.label}>
                  {items.slice(0, OVERVIEW_PER_SECTION).map((family) => card(family))}
                </CardGrid>
              </GallerySection>
            )
          );
        })}
      </>
    );
  }

  const quickLookFamily = quickLook === null ? undefined : findExampleFamily(quickLook, families);
  const quickLookVersion =
    quickLookFamily?.versions.find((version) => version.slug === quickLook) ?? quickLookFamily?.versions[0];

  return (
    <>
      {workspace.banners}
      <SiteMain className="gap-4 pt-7">
        <div ref={anchor} className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="flex-1 font-display text-[24px] font-semibold tracking-[-0.03em] whitespace-nowrap">
            Examples &amp; guides
          </h1>
          <div className="relative w-full max-w-110 max-phone:order-last max-phone:max-w-none">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
              aria-hidden="true"
            />
            <input
              ref={searchInput}
              className="h-10 w-full rounded-md border border-border bg-surface pr-16 pl-9 text-[13px] text-text focus-visible:border-accent-text focus-visible:outline-transparent max-phone:h-touch"
              type="search"
              placeholder={phone ? "Search a task or an API" : "Search a task or an API: cursor, leftJoin, jsonb_set…"}
              aria-label="Search examples and guides"
              value={view.kind === "search" ? view.query : ""}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && event.currentTarget.value !== "") {
                  event.preventDefault();
                  setSearch("");
                }
              }}
            />
            <kbd className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 rounded-sm border border-border px-1.5 font-sans text-[11px] text-muted max-phone:hidden">
              /
            </kbd>
          </div>
          <span className="flex items-center gap-2 max-phone:w-full">
            <span className="text-[13px] text-muted max-phone:hidden">I use</span>
            <ToggleGroup
              label="Database"
              options={GALLERY_DIALECTS}
              value={dialect}
              onChange={changeDialect}
              className="max-phone:flex-1"
            />
          </span>
        </div>
        <div className="grid grid-cols-[180px_minmax(0,1fr)] items-start gap-8 max-phone:grid-cols-1 max-phone:gap-3">
          <SectionNav view={view} counts={(section) => sectionFamilies(section).length} total={families.length} />
          <div className="flex min-w-0 flex-col gap-6">{content}</div>
        </div>
      </SiteMain>
      <Drawer
        open={quickLookVersion !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setQuickLook(null);
          }
        }}
        swipeDirection={phone ? "down" : "right"}
      >
        <DrawerContent
          initialFocus={quickLookClose}
          className={cn(
            "gap-0 p-0",
            phone
              ? "max-h-[85dvh] border border-b-0 border-border pb-[env(safe-area-inset-bottom)]"
              : "rounded-none border-l border-border data-[swipe-axis=x]:[--drawer-content-width:92vw] data-[swipe-axis=x]:sm:[--drawer-content-width:440px]",
          )}
        >
          {quickLookFamily && quickLookVersion && (
            <div className="relative flex min-h-0 flex-1 flex-col">
              <button
                type="button"
                ref={quickLookClose}
                className="absolute top-3.5 right-3.5 z-1 flex size-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
                aria-label="Close quick look"
                onClick={() => setQuickLook(null)}
              >
                <XIcon className="size-4" aria-hidden="true" />
              </button>
              <ExamplePreview
                key={quickLookVersion.slug}
                example={quickLookVersion}
                progress={saved.progress[quickLookVersion.slug]}
                title={getFamilyTitle(quickLookFamily, quickLookVersion)}
                renderTitle={(title) => (
                  <DrawerTitle className="mt-2 pr-8 text-[20px]/[1.3] font-semibold tracking-[-0.02em]">
                    {title}
                  </DrawerTitle>
                )}
                controls={
                  quickLookFamily.versions.length > 1 && (
                    <ToggleGroup
                      label="Version"
                      options={quickLookFamily.versions.map((version) => ({
                        value: version.slug,
                        label: getVersionDialectLabel(version),
                      }))}
                      value={quickLookVersion.slug}
                      onChange={setQuickLook}
                      className="w-fit"
                    />
                  )
                }
              />
            </div>
          )}
        </DrawerContent>
      </Drawer>
    </>
  );
}

/** Cards in as many columns as fit. */
function CardGrid({ label, children }: { label: string; children: readonly ReactNode[] }) {
  return (
    <ul
      className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))] gap-2.5"
      role="list"
      aria-label={label}
    >
      {children.map((item, index) => (
        <li key={index} className="flex min-w-0 [&>article]:flex-1">
          {item}
        </li>
      ))}
    </ul>
  );
}

/** A titled group of the gallery, with its count and a link to the rest. */
function GallerySection({
  title,
  note,
  count,
  more,
  children,
}: {
  title: string;
  note?: string;
  count?: number;
  more?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5" aria-label={title}>
      <div className="flex items-baseline gap-2">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {count !== undefined && <span className="text-[13px] text-muted">{count}</span>}
        {note && <span className="text-[13px] text-muted max-phone:hidden">{note}</span>}
        {more && <span className="ml-auto">{more}</span>}
      </div>
      {children}
    </section>
  );
}

function Breadcrumb({ current }: { current: string }) {
  return (
    <nav aria-label="Breadcrumb" className="text-[12px] text-muted">
      <Link to="?" className="text-muted no-underline hover:text-text hover:underline">
        Examples &amp; guides
      </Link>{" "}
      / <span aria-current="page">{current}</span>
    </nav>
  );
}

/** The gallery's table of contents: a sticky column on desktop, a row of chips that scrolls on phones. */
function SectionNav({
  view,
  counts,
  total,
}: {
  view: GalleryView;
  counts: (section: ExampleSectionId) => number;
  total: number;
}) {
  const items = [
    {
      to: "?",
      label: "Overview",
      count: total,
      active: view.kind === "overview",
    },
    ...EXAMPLE_SECTIONS.map((section) => ({
      to: `?section=${section.id}`,
      label: section.label,
      count: counts(section.id),
      active: view.kind === "section" && view.section === section.id,
    })),
  ].filter((item) => item.count > 0);

  return (
    <nav
      aria-label="Gallery sections"
      className="sticky top-0 flex flex-col gap-px text-[13px] max-phone:static max-phone:-mx-4 max-phone:scrollbar-none max-phone:flex-row max-phone:gap-1.5 max-phone:overflow-x-auto max-phone:px-4"
    >
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          aria-current={item.active ? "page" : undefined}
          className={cn(
            "flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 whitespace-nowrap no-underline",
            "max-phone:min-h-9 max-phone:rounded-full max-phone:border max-phone:border-border max-phone:bg-surface max-phone:px-3",
            item.active
              ? "bg-surface-2 font-semibold text-text max-phone:border-segment max-phone:bg-segment max-phone:text-segment-fg"
              : "text-soft hover:bg-surface-2 hover:text-text",
          )}
        >
          {item.label}
          <span className={cn("text-[12px] text-muted", item.active && "max-phone:text-segment-fg/70")}>
            {item.count}
          </span>
        </Link>
      ))}
    </nav>
  );
}
