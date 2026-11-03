import { useState } from "react";
import { NavLink, Outlet, useLoaderData, useSearchParams, type LoaderFunctionArgs } from "react-router";

import { appServicesContext } from "../app-services";
import { useAuth } from "../auth/auth-provider";
import { CloudUsageStrip } from "../cloud/cloud-usage";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/utils";
import { MY_SHARES_PATH } from "../my-shares/my-shares-section";
import { SiteMain } from "../shell/site-header";
import { EmptyState } from "../ui/empty-state";
import { ToggleGroup } from "../ui/toggle-group";
import { useWorkspace } from "../workspace/context";
import {
  listProjects,
  readListQuery,
  toProjectShares,
  writeListQuery,
  type DialectFilter,
  type ProjectListQuery,
  type ProjectShare,
} from "./project-list";
import { ProjectTable } from "./project-table";

const DIALECTS: readonly { value: DialectFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "postgresql", label: "PostgreSQL" },
  { value: "sqlite", label: "SQLite" },
];

const tabLinkClass = ({ isActive, isPending }: { isActive: boolean; isPending: boolean }) =>
  cn(
    "relative inline-flex items-center py-2.25 text-[14px] font-medium whitespace-nowrap no-underline max-phone:min-h-touch",
    "after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-text after:opacity-0",
    isActive ? "text-text after:opacity-100" : "text-muted hover:text-text",
    isPending && "opacity-60",
  );

function ProjectsTabs() {
  return (
    <nav className="flex gap-6 border-b border-border" aria-label="My projects and shares">
      <NavLink to="/projects" end className={tabLinkClass}>
        My projects
      </NavLink>
      <NavLink to={MY_SHARES_PATH} className={tabLinkClass}>
        My shares
      </NavLink>
    </nav>
  );
}

/**
 * My projects and My shares, one tab each
 *
 * The tabs show only for a signed-in account, since My shares lists its links.
 */
export function ProjectsLayout() {
  const workspace = useWorkspace();
  const auth = useAuth();

  if (workspace.loading) {
    return (
      <>
        {workspace.banners}
        <LoadingProjects />
      </>
    );
  }

  return (
    <>
      {workspace.banners}
      <SiteMain className="gap-4.5">
        {auth.user !== null && <ProjectsTabs />}
        <Outlet context={workspace} />
      </SiteMain>
    </>
  );
}

/**
 * My projects' loader: each project's share link in this browser, by project id
 *
 * Share links only add a column, so an unreadable store shows every project as not shared.
 */
export async function loadProjectShares({ context }: LoaderFunctionArgs): Promise<Record<string, ProjectShare>> {
  try {
    return toProjectShares(await context.get(appServicesContext).localShares.listShareLinks());
  } catch {
    return {};
  }
}

/** What My projects shows while its share links load. */
export function LoadingProjects() {
  return (
    <EmptyState>
      <Skeleton className="h-7 w-56" />
      <p>
        <output>Loading local projects…</output>
      </p>
    </EmptyState>
  );
}

/** My projects: every local project, searchable and paged. */
export function ProjectsPage() {
  const workspace = useWorkspace();
  const shares = useLoaderData<typeof loadProjectShares>();
  const [params, setParams] = useSearchParams();
  const query = readListQuery(params);
  const page = listProjects(workspace.projects, query);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const selectedProjects = workspace.projects.filter((project) => selected.has(project.id));
  const total = workspace.projects.length;

  const setQuery = (next: Partial<ProjectListQuery>) => {
    setParams(writeListQuery({ ...query, page: 1, ...next }), { replace: true });
  };

  return (
    <section className="flex min-w-0 flex-col gap-2.5 max-phone:gap-3.5" aria-labelledby="projects-title">
      <div className="flex flex-wrap items-center gap-2.5 max-phone:gap-3.5">
        <h1 id="projects-title" className="font-display text-[28px] font-bold tracking-[-0.02em] max-phone:text-[24px]">
          My projects <span className="ml-1 font-sans text-[15px] font-medium tracking-normal text-muted">{total}</span>
        </h1>
        <div className="ml-auto flex flex-wrap items-center gap-2 max-phone:ml-0 max-phone:w-full">
          <input
            className="h-9 w-60 rounded-md border border-border bg-surface px-3 text-text focus-visible:border-accent-text focus-visible:outline-transparent max-phone:h-touch max-phone:w-full max-phone:rounded-[12px] max-phone:px-3.5"
            type="search"
            placeholder={`Search ${total} project${total === 1 ? "" : "s"}`}
            aria-label="Search projects"
            value={query.search}
            onChange={(event) => setQuery({ search: event.target.value })}
          />
          <ToggleGroup
            label="Database"
            options={DIALECTS}
            value={query.dialect}
            onChange={(dialect) => setQuery({ dialect })}
            className="max-phone:hidden"
          />
          <Button
            variant="outline"
            className="rounded-md max-phone:hidden"
            onClick={() => workspace.exportProjects(workspace.projects, "drizzle-run-projects.json")}
          >
            Export all
          </Button>
        </div>
      </div>
      <CloudUsageStrip cloudSync={workspace.cloudSync} />
      <ProjectTable
        page={page}
        shares={shares}
        sort={query.sort}
        selected={selected}
        onSelectedChange={setSelected}
        onSortChange={(sort) => setQuery({ sort, page: query.page })}
        onPageChange={(next) => setQuery({ page: next })}
        onClearFilters={() => setParams(new URLSearchParams(), { replace: true })}
        filtered={query.search.trim() !== "" || query.dialect !== "all"}
        selection={
          selectedProjects.length > 0 && (
            <fieldset
              className="flex min-w-auto flex-wrap items-center gap-1.5 font-medium text-text"
              aria-label="Selected projects"
            >
              <span className="mr-1">{selectedProjects.length} selected</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => workspace.exportProjects(selectedProjects, "drizzle-run-projects.json")}
              >
                Export
              </Button>
              <Button variant="destructive" size="sm" onClick={() => workspace.remove(selectedProjects)}>
                Delete
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </fieldset>
          )
        }
      />
    </section>
  );
}
