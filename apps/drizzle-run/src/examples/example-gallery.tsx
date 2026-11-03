import type { RunManifestTarget } from "@drizzle-run/core/manifest";
import type { GuideProgress } from "@drizzle-run/runtime/machines";
import {
  useLoaderData,
  useSearchParams,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunctionArgs,
} from "react-router";

import { appServicesContext } from "../app-services";
import { Skeleton } from "../components/ui/skeleton";
import { readExampleProgress } from "../guides/guide-progress";
import { cn } from "../lib/utils";
import { listProjectDialects } from "../project/projects";
import { SiteMain } from "../shell/site-header";
import { Chip } from "../ui/chip";
import { ToggleGroup } from "../ui/toggle-group";
import { useWorkspace } from "../workspace/context";
import { getExampleKind, listExamples, listExampleTopics, type ExampleKind, type ExampleTopic } from "./catalog";
import { ExampleCard } from "./example-card";

type DatabaseFilter = "all" | RunManifestTarget["dialect"];

const DATABASES: readonly { value: DatabaseFilter; label: string }[] = [
  { value: "all", label: "Any database" },
  { value: "postgresql", label: "PostgreSQL" },
  { value: "sqlite", label: "SQLite" },
];

const KINDS: readonly { value: "all" | ExampleKind; label: string }[] = [
  { value: "all", label: "Any kind" },
  { value: "guided", label: "Guided" },
  { value: "example", label: "Examples" },
];

const filterGroupClass = cn("ml-auto max-phone:ml-0 max-phone:w-full");

/** Load the Examples page's saved guide progress, so each guided card shows how far it got. */
export async function loadExampleGallery({ context }: LoaderFunctionArgs) {
  const { settings } = context.get(appServicesContext);

  return { progress: await readExampleProgress(settings, listExamples()) };
}

/** Skip the progress read when only a filter changes: progress moves only while a guide plays, on another page. */
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

/** The Examples page: official examples filtered by topic, database and kind from the search params. */
export function ExampleGallery() {
  const { progress } = useLoaderData<typeof loadExampleGallery>();

  return <Gallery progress={progress} />;
}

/** The Examples page while the app opens and reads the guide progress. */
export function LoadingExampleGallery() {
  const workspace = useWorkspace();

  return (
    <>
      {workspace.banners}
      <SiteMain className="gap-4.5 pt-7">
        <Skeleton className="w-72 h-10" />
        <p>
          <output>Loading examples…</output>
        </p>
      </SiteMain>
    </>
  );
}

function Gallery({ progress }: { progress: Readonly<Record<string, GuideProgress>> }) {
  const workspace = useWorkspace();
  const [params, setParams] = useSearchParams();
  const examples = listExamples();
  const topics = listExampleTopics(examples);
  const topic = topics.find((item) => item === params.get("topic"));
  const database = DATABASES.find((item) => item.value === params.get("db"))?.value ?? "all";
  const kind = KINDS.find((item) => item.value === params.get("kind"))?.value ?? "all";
  const featured = examples.find((example) => example.featured);
  const filtered = topic !== undefined || database !== "all" || kind !== "all";
  const visible = examples.filter(
    (example) =>
      (topic === undefined || example.topic === topic) &&
      (database === "all" || listProjectDialects(example.manifest).includes(database)) &&
      (kind === "all" || getExampleKind(example) === kind) &&
      (filtered || example !== featured),
  );

  const setFilter = (key: "topic" | "db" | "kind", value: string | undefined) => {
    const next = new URLSearchParams(params);

    if (value === undefined || value === "all") {
      next.delete(key);
    } else {
      next.set(key, value);
    }

    setParams(next, { replace: true });
  };

  return (
    <>
      {workspace.banners}
      <SiteMain className="gap-4.5 pt-7">
        <div className="flex max-phone:flex-col items-stretch gap-6">
          <div className="flex flex-col flex-1 justify-center gap-2">
            <h1 className="font-display font-extrabold text-[38px] max-phone:text-[30px] tracking-[-0.02em]">
              Official <mark>Examples &amp; Guides</mark>
            </h1>
            <p className="max-w-130 text-[15px] text-muted leading-[1.6]">
              Each one opens as a scratch copy you can edit and run. Fork it to keep it. Guided ones walk you through it
              first, then unlock the code.
            </p>
          </div>
          {featured && (
            <section className="flex w-115 max-phone:w-auto shrink-0" aria-label="Featured example">
              <ExampleCard example={featured} featured progress={progress[featured.slug]} className="flex-1" />
            </section>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <fieldset
            className="flex flex-wrap max-phone:flex-nowrap gap-1.5 max-phone:w-full min-w-auto max-phone:overflow-x-auto max-phone:scrollbar-none"
            aria-label="Topic"
          >
            <Chip pressed={topic === undefined} onClick={() => setFilter("topic", undefined)}>
              All
            </Chip>
            {topics.map((item: ExampleTopic) => (
              <Chip key={item} pressed={topic === item} onClick={() => setFilter("topic", item)}>
                {item}
              </Chip>
            ))}
          </fieldset>
          <ToggleGroup
            label="Kind"
            options={KINDS}
            value={kind}
            onChange={(value) => setFilter("kind", value)}
            className={filterGroupClass}
          />
          <ToggleGroup
            label="Database"
            options={DATABASES}
            value={database}
            onChange={(value) => setFilter("db", value)}
            className={filterGroupClass}
          />
        </div>
        {visible.length === 0 ? (
          <p className="my-6 text-muted">No example matches these filters yet.</p>
        ) : (
          // role="list" because Safari drops list semantics from a list without bullets.
          <ul
            className="gap-3.5 grid grid-cols-3 max-phone:grid-cols-1 max-wide:grid-cols-2"
            role="list"
            aria-label="Example list"
          >
            {visible.map((example) => (
              <li key={example.slug} className="flex min-w-0">
                <ExampleCard example={example} progress={progress[example.slug]} className="flex-1" />
              </li>
            ))}
          </ul>
        )}
      </SiteMain>
    </>
  );
}
