import type { RunManifestTarget } from "@drizzle-run/core/manifest";
import { PlayIcon } from "lucide-react";
import { Link, useNavigate } from "react-router";

import { buttonVariants } from "../components/ui/button";
import { findExample, listExamples, type OfficialExample } from "../examples/catalog";
import { getGuidedProjectPath, resolveFirstProject } from "../guides/first-project";
import { getErrorText } from "../lib/error-text";
import { cn } from "../lib/utils";
import { SiteMain } from "../shell/site-header";
import { KindBadge } from "../ui/kind-badge";
import { useWorkspace } from "../workspace/context";

const STARTERS = [
  {
    dialect: "postgresql",
    title: "PostgreSQL",
    description: "A users table, seed data, and a short guide through your first run.",
  },
  { dialect: "sqlite", title: "SQLite", description: "The same starter project and guide on SQLite." },
] as const;

/** The guided tour newcomers start from, offered before the blank starters. */
const TOUR_SLUG = "drizzle-in-five-minutes";

/** The home, for first visits and returning users alike: projects live on /projects. */
export function WelcomePage() {
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const tour = findExample(TOUR_SLUG);
  const moreExamples = listExamples().filter(
    (example) => example.slug !== TOUR_SLUG && !example.slug.startsWith("quick-start-"),
  );

  const start = (dialect: RunManifestTarget["dialect"]) => {
    void resolveFirstProject(workspace.storage, workspace.projects, dialect).then((first) => {
      if (!first) {
        workspace.quickCreate({ dialect });
        return;
      }

      try {
        if (first.created) {
          workspace.add(first.project, { open: false });
        }

        void navigate(getGuidedProjectPath(first.project.id, first.guideSlug));
      } catch (cause) {
        workspace.reportError(getErrorText(cause));
      }
    });
  };

  return (
    <>
      <div className="relative z-1">{workspace.banners}</div>
      <SiteMain className="relative z-1 max-w-none items-center justify-center-safe gap-11 px-4 py-12 max-phone:gap-9 max-phone:py-9">
        <div className="flex max-w-160 flex-col items-center gap-4 text-center">
          <h1 className="font-display text-[52px] leading-[1.05] font-extrabold tracking-[-0.03em] max-phone:text-[34px]">
            Write a schema. Seed it. <mark className="px-2">Run</mark> a query.
          </h1>
          <p className="text-[17px] leading-[1.6] text-muted">
            Real Drizzle ORM and Kit run in your browser, with a fresh database on every run. Nothing to install.
          </p>
        </div>
        {tour && (
          <div className="flex flex-col items-center gap-3 text-center">
            <Link
              to={`/examples/${tour.slug}`}
              className={cn(
                buttonVariants({ variant: "sticker" }),
                "h-13 gap-2.5 rounded-[12px] px-7 text-[17px] no-underline [&>svg]:size-4 [&>svg]:fill-current",
              )}
            >
              <PlayIcon aria-hidden="true" />
              {tour.title}
            </Link>
            <span className="text-[14px] text-muted">New to Drizzle? A guided tour, nothing to set up.</span>
          </div>
        )}
        <div className="flex w-full max-w-120 flex-col items-center gap-3">
          <span className="text-[14px] font-medium">Or start your own project</span>
          <div className="grid w-full grid-cols-2 gap-4 max-phone:grid-cols-1 max-phone:gap-3">
            {STARTERS.map((starter) => (
              <button
                key={starter.dialect}
                type="button"
                title={starter.description}
                className="flex items-center justify-between gap-3 rounded-[14px] border-[1.5px] border-card-border bg-surface px-5 py-4 text-left text-text shadow-sticker-card active:translate-px active:shadow-none disabled:opacity-60"
                disabled={workspace.loading}
                onClick={() => start(starter.dialect)}
              >
                <span className="font-display text-[19px] font-bold">{starter.title}</span>
                <span className="text-[14px] font-semibold whitespace-nowrap">Create →</span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex w-full max-w-180 flex-col items-center gap-3">
          <span className="text-[14px] font-medium">More official examples</span>
          <ExampleStrip examples={moreExamples} />
          <Link
            to="/examples"
            className="inline-flex h-10 items-center px-2.5 font-medium text-accent-text hover:text-text"
          >
            All examples →
          </Link>
        </div>
      </SiteMain>
    </>
  );
}

/**
 * The official examples drifting slowly sideways. The list is drawn twice so a move by half loops without a seam;
 * the copy is inert. Hover or focus pauses it, and reduced motion holds it still (theme.css).
 */
function ExampleStrip({ examples }: { examples: readonly OfficialExample[] }) {
  const chips = (copy: boolean) => (
    <ul
      className="flex shrink-0 gap-2.5 pr-2.5"
      aria-label={copy ? undefined : "More official examples"}
      aria-hidden={copy || undefined}
      inert={copy}
    >
      {examples.map((example) => (
        <li key={example.slug}>
          <Link
            to={`/examples/${example.slug}`}
            className="inline-flex h-10 items-center gap-2 rounded-pill border border-border bg-surface px-3.5 font-medium whitespace-nowrap text-text no-underline hover:border-muted"
          >
            <KindBadge tone="lime" className="px-1.5 py-px">
              Official
            </KindBadge>
            {example.title}
          </Link>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="group w-full overflow-hidden mask-x-from-85% py-1">
      <div className="flex w-max animate-marquee group-focus-within:[animation-play-state:paused] group-hover:[animation-play-state:paused]">
        {chips(false)}
        {chips(true)}
      </div>
    </div>
  );
}
