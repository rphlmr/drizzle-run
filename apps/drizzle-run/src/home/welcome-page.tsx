import type { RunManifestTarget } from "@drizzle-run/core/manifest";
import { Columns2Icon, PlayIcon } from "lucide-react";
import { Link, useNavigate } from "react-router";

import { buttonVariants } from "../components/ui/button";
import { findExample } from "../examples/catalog";
import { getGuidedProjectPath, resolveFirstProject } from "../guides/first-project";
import { getErrorText } from "../lib/error-text";
import { cn } from "../lib/utils";
import { SiteMain } from "../shell/site-header";
import { DialectLogo } from "../ui/dialect-logo";
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
      {workspace.banners}
      <SiteMain className="max-w-275 justify-center-safe gap-10 px-10 py-12 max-phone:justify-start max-phone:gap-8 max-phone:px-4 max-phone:pt-6 max-phone:pb-8">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] items-center gap-12 max-wide:grid-cols-1 max-wide:gap-8">
          <div className="flex flex-col items-start gap-5">
            <span className="rounded-pill border border-border px-3 py-0.75 text-[12.5px] text-muted">
              Drizzle ORM and Kit, in your browser
            </span>
            <h1 className="font-display text-[44px] leading-[1.08] font-semibold tracking-[-0.035em] max-phone:text-[32px]">
              Write a schema. Seed it. <mark className="rounded-md px-1.5">Run</mark> a query.
            </h1>
            <p className="max-w-110 text-[16px] leading-[1.6] text-muted">
              Real Drizzle ORM and Kit, with a fresh database on every run. Nothing to install.
            </p>
            <div className="flex flex-wrap items-center gap-2.5">
              {tour && (
                <Link
                  to={`/examples/${tour.slug}`}
                  className={cn(
                    buttonVariants({ variant: "sticker" }),
                    "h-10 gap-2 px-4.5 no-underline [&>svg]:size-3.5 [&>svg]:fill-current",
                  )}
                >
                  <PlayIcon aria-hidden="true" />
                  {tour.title}
                </Link>
              )}
              <Link to="/examples" className={cn(buttonVariants({ variant: "outline" }), "h-10 px-4 no-underline")}>
                All examples →
              </Link>
            </div>
          </div>
          <RunPreview />
        </div>
        <div className="flex flex-col gap-3">
          <span className="text-[13px] font-medium text-muted">Or start your own project</span>
          <div className="grid grid-cols-3 gap-3 max-wide:grid-cols-1">
            {STARTERS.map((starter) => (
              <button
                key={starter.dialect}
                type="button"
                title={starter.description}
                className={tileClass}
                disabled={workspace.loading}
                onClick={() => start(starter.dialect)}
              >
                <DialectMark dialect={starter.dialect} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-semibold">{starter.title}</span>
                  <span className="text-[12.5px] text-muted">Starter project and guide</span>
                </span>
                <span className="text-muted" aria-hidden="true">
                  →
                </span>
              </button>
            ))}
            <button type="button" className={tileClass} disabled={workspace.loading} onClick={workspace.openCreate}>
              <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-surface-2 text-muted">
                <Columns2Icon className="size-4" aria-hidden="true" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-semibold">Side by side</span>
                <span className="text-[12.5px] text-muted">Compare two releases or databases</span>
              </span>
              <span className="text-muted" aria-hidden="true">
                →
              </span>
            </button>
          </div>
        </div>
      </SiteMain>
    </>
  );
}

const tileClass = cn(
  "flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3.5 text-left text-[14px] text-text shadow-sticker transition-colors hover:bg-surface-2 disabled:opacity-60",
);

/** The database logo of a starter tile. */
function DialectMark({ dialect }: { dialect: RunManifestTarget["dialect"] }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-2" aria-hidden="true">
      <DialectLogo dialect={dialect} className="size-4.5" />
    </span>
  );
}

/** A still picture of a run: a query and the rows it returned. Decorative, so screen readers skip it. */
function RunPreview() {
  return (
    <div
      className="overflow-hidden rounded-lg border border-border bg-surface shadow-sticker-lg max-phone:hidden"
      aria-hidden="true"
    >
      <div className="flex items-center gap-1 border-b border-border px-2.5 py-1.5 font-mono text-[12px]">
        <span className="rounded-sm bg-surface-2 px-2 py-0.5 text-text">query.ts</span>
        <span className="px-2 py-0.5 text-muted">schema.ts</span>
        <span className="px-2 py-0.5 text-muted">seed.ts</span>
        <span className="ml-auto font-sans text-[12px] text-ok">● 12 ms</span>
      </div>
      <pre className="m-0 px-4 py-3.5 font-mono text-[12.5px] leading-[1.75] text-soft">
        <span className="text-c-key">const</span> active = <span className="text-c-key">await</span> db.
        <span className="text-c-fn">select</span>().<span className="text-c-fn">from</span>(users){"\n"}
        {"  "}.<span className="text-c-fn">where</span>(<span className="text-c-fn">eq</span>(users.active,{" "}
        <span className="text-c-key">true</span>));{"\n"}
        {"\n"}$.<span className="text-c-fn">display</span>(<span className="text-c-str">"Active users"</span>, active);
      </pre>
      <div className="mx-3.5 mb-3.5 overflow-hidden rounded-md border border-border text-[12.5px]">
        <div className="border-b border-border bg-surface-2 px-3 py-1.5 font-medium">Active users</div>
        <div className="grid grid-cols-[36px_1fr_1.4fr] border-b border-border px-3 py-1.5 text-muted">
          <span>id</span>
          <span>name</span>
          <span>email</span>
        </div>
        {[
          ["1", "Ada Lovelace", "ada@drizzle.run"],
          ["2", "Linus Torvalds", "linus@drizzle.run"],
          ["3", "Grace Hopper", "grace@drizzle.run"],
        ].map(([id, name, email]) => (
          <div key={id} className="grid grid-cols-[36px_1fr_1.4fr] px-3 py-1.5 [&+&]:border-t [&+&]:border-border">
            <span className="text-muted">{id}</span>
            <span>{name}</span>
            <span className="text-muted">{email}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
