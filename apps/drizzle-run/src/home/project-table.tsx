import { ChevronRightIcon, MoreHorizontalIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";

import { cloudMoveBlockLabels } from "../cloud/cloud-labels";
import type { CloudSync } from "../cloud/cloud-sync";
import { isCloudSyncActive } from "../cloud/cloud-usage";
import { ProjectLocationMenu } from "../cloud/project-location";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { cn } from "../lib/utils";
import { ShareVisibilityBadge } from "../my-shares/share-visibility";
import type { ProjectRecord } from "../project/projects";
import { isSideBySide } from "../project/projects";
import { CopyLinkButton } from "../share/copy-link-button";
import { ReleaseLines } from "../ui/release-lines";
import { formatBytes } from "../ui/run-report";
import { SideBySideTag } from "../ui/side-by-side-tag";
import { PHONE_QUERY, useMediaQuery } from "../ui/use-media-query";
import { useWorkspace } from "../workspace/context";
import {
  formatEditedLabel,
  getProjectBytes,
  getProjectReleaseLines,
  type ProjectListPage,
  type ProjectShare,
  type ProjectSort,
} from "./project-list";

export interface ProjectTableProps {
  page: ProjectListPage;
  /** Each project's share link in this browser, by project id. */
  shares: Readonly<Record<string, ProjectShare>>;
  sort: ProjectSort;
  selected: ReadonlySet<string>;
  onSelectedChange: (selected: ReadonlySet<string>) => void;
  onSortChange: (sort: ProjectSort) => void;
  onPageChange: (page: number) => void;
  onClearFilters: () => void;
  /** A search or filter is active, so an empty page means "no match". */
  filtered: boolean;
  /** Bulk actions for the selected projects, shown in the footer so the rows never move. */
  selection?: ReactNode;
}

const thClass = cn(
  "border-b border-border bg-surface-2 px-2 py-[9px] text-left font-medium whitespace-nowrap text-muted",
);
const tdClass = cn("border-b border-surface-2 p-2");
const mutedCellClass = cn(tdClass, "whitespace-nowrap text-muted");
const checkClass = cn("w-10 pl-3.5");
const actionsClass = cn("w-12 text-right");
const frameClass = cn("flex flex-col overflow-hidden rounded-lg border border-border bg-surface");

const phoneShareLabels: Record<ProjectShare["visibility"], string> = {
  link_only: "shared",
  community: "in Community",
};

function ShareCell({ project, share }: { project: ProjectRecord; share: ProjectShare | undefined }) {
  if (share === undefined) {
    return <span className="whitespace-nowrap text-muted">Not shared</span>;
  }

  return (
    <span className="flex items-center gap-1 whitespace-nowrap">
      <ShareVisibilityBadge visibility={share.visibility} bugRepro={share.bugRepro} />
      <CopyLinkButton linkId={share.linkId} title={project.name} variant="icon" />
    </span>
  );
}

function RowActions({ project }: { project: ProjectRecord }) {
  const workspace = useWorkspace();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="relative after:absolute after:-inset-1.75"
            aria-label={`Actions for ${project.name}`}
          />
        }
      >
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem render={<Link to={`/p/${project.id}`} />}>Open</DropdownMenuItem>
        <DropdownMenuItem onClick={() => workspace.rename(project)}>Rename…</DropdownMenuItem>
        <DropdownMenuItem onClick={() => workspace.duplicate(project)}>Duplicate</DropdownMenuItem>
        <DropdownMenuItem onClick={() => workspace.exportProjects([project])}>Export JSON</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => workspace.remove([project])}>
          Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const cloudNotes = {
  too_large: "Over 1 MB",
  limit: "No room",
  failed: "Not saved",
} as const;

const blockNotes = {
  too_large: "Over 1 MB",
  account_full: "Cloud full",
} as const;

function CloudLocation({ project, cloudSync }: { project: ProjectRecord; cloudSync: CloudSync }) {
  const workspace = useWorkspace();
  const state = cloudSync.getProjectState(project.id);
  const inCloud = cloudSync.isCloudProject(project.id);
  const block = cloudSync.getMoveBlock(project.id);
  const note =
    inCloud && (state === "too_large" || state === "limit" || state === "failed")
      ? cloudNotes[state]
      : block !== null
        ? blockNotes[block]
        : undefined;
  const reason =
    state === "failed"
      ? cloudSync.failures.find((failure) => failure.id === project.id)?.message
      : block !== null
        ? cloudMoveBlockLabels[block]
        : undefined;

  if (state === "unsyncable") {
    return <span className="text-[13px] text-muted">Local</span>;
  }

  return (
    <span className="inline-flex items-center gap-2">
      <ProjectLocationMenu project={project} cloudSync={cloudSync} onDuplicate={() => workspace.duplicate(project)} />
      {note !== undefined && (
        <span className="text-[12px] text-err" title={reason}>
          {note}
        </span>
      )}
    </span>
  );
}

function SortHeader({
  label,
  sort,
  ascending,
  descending,
  onSortChange,
}: {
  label: string;
  sort: ProjectSort;
  ascending: ProjectSort;
  descending: ProjectSort;
  onSortChange: (sort: ProjectSort) => void;
}) {
  const active = sort === ascending || sort === descending;
  const direction = sort === ascending ? "ascending" : "descending";

  return (
    <th scope="col" className={thClass} aria-sort={active ? direction : undefined}>
      <button
        type="button"
        className={cn("border-0 bg-transparent p-0", active && "text-text")}
        onClick={() => onSortChange(sort === descending ? ascending : descending)}
      >
        {label}
        {active && <span aria-hidden="true">{sort === ascending ? " ↑" : " ↓"}</span>}
      </button>
    </th>
  );
}

/**
 * The My projects table: sortable columns, row selection, paging, and an empty state that tells no match from no
 * projects. Phones get a list instead, whose rows open the project.
 */
export function ProjectTable({
  page,
  shares,
  sort,
  selected,
  onSelectedChange,
  onSortChange,
  onPageChange,
  onClearFilters,
  filtered,
  selection,
}: ProjectTableProps) {
  const phone = useMediaQuery(PHONE_QUERY);
  const { cloudSync, openCreate } = useWorkspace();
  const syncing = isCloudSyncActive(cloudSync);
  const maxProjectBytes = cloudSync.usage?.maxProjectBytes ?? 1024 * 1024;
  const [now] = useState(() => new Date());
  const pageIds = page.rows.map((project) => project.id);
  const selectedOnPage = pageIds.filter((id) => selected.has(id)).length;

  const toggleProject = (id: string, checked: boolean) => {
    const next = new Set(selected);

    if (checked) {
      next.add(id);
    } else {
      next.delete(id);
    }

    onSelectedChange(next);
  };

  const togglePage = (checked: boolean) => {
    const next = new Set(selected);

    for (const id of pageIds) {
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
    }

    onSelectedChange(next);
  };

  if (page.matched === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-10 text-muted">
        <p>{filtered ? "No project matches these filters." : "No projects yet."}</p>
        {filtered ? (
          <Button variant="outline" onClick={onClearFilters}>
            Clear filters
          </Button>
        ) : (
          <span className="flex flex-wrap justify-center gap-2">
            <Button variant="outline" onClick={openCreate}>
              New project
            </Button>
            <Button variant="ghost" nativeButton={false} render={<Link to="/examples" />}>
              Browse examples
            </Button>
          </span>
        )}
      </div>
    );
  }

  const footer = (
    <div className="flex min-h-13 flex-wrap items-center gap-3 px-3.5 py-2 text-[13px] text-muted">
      {selection || (
        <span>
          Showing {page.from} to {page.to} of {page.matched}
        </span>
      )}
      <span className="ml-auto max-phone:hidden">
        {selection
          ? `Showing ${page.from} to ${page.to} of ${page.matched}`
          : syncing
            ? "Local projects stay in this browser. Move one to Cloud to keep it in your account."
            : "Stored in this browser"}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="max-phone:ml-auto"
        onClick={() => onPageChange(page.page - 1)}
        disabled={page.page <= 1}
      >
        Previous
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => onPageChange(page.page + 1)}
        disabled={page.page >= page.pageCount}
      >
        Next
      </Button>
    </div>
  );

  if (phone) {
    return (
      <div className={frameClass}>
        <ul aria-label="Projects">
          {page.rows.map((project) => (
            <li key={project.id} className="flex items-center border-b border-surface-2">
              <Link
                to={`/p/${project.id}`}
                className="flex min-h-touch min-w-0 flex-1 items-center gap-2.5 px-3.5 py-3 text-text no-underline"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-semibold">{project.name}</span>
                    {isSideBySide(project) && <SideBySideTag />}
                  </span>
                  <ReleaseLines lines={getProjectReleaseLines(project)} className="text-[13px]" />
                  <span className="text-[13px] text-muted">
                    {syncing && `${formatBytes(getProjectBytes(project))} · `}edited{" "}
                    {formatEditedLabel(project.updatedAt, now).toLocaleLowerCase()}
                    {shares[project.id] !== undefined && ` · ${phoneShareLabels[shares[project.id].visibility]}`}
                  </span>
                </span>
                {!syncing && <ChevronRightIcon className="size-4 shrink-0 text-muted" aria-hidden="true" />}
              </Link>
              {syncing && (
                <span className="flex min-h-touch shrink-0 items-center pr-3.5">
                  <CloudLocation project={project} cloudSync={cloudSync} />
                </span>
              )}
            </li>
          ))}
        </ul>
        {footer}
      </div>
    );
  }

  return (
    <div className={frameClass}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[14px]">
          <thead>
            <tr>
              <th scope="col" className={cn(thClass, checkClass)}>
                <Checkbox
                  aria-label="Select all projects on this page"
                  checked={selectedOnPage > 0 && selectedOnPage === pageIds.length}
                  indeterminate={selectedOnPage > 0 && selectedOnPage < pageIds.length}
                  onCheckedChange={togglePage}
                />
              </th>
              <SortHeader
                label="Name"
                sort={sort}
                ascending="name-asc"
                descending="name-desc"
                onSortChange={onSortChange}
              />
              <th scope="col" className={thClass}>
                Database and Drizzle
              </th>
              <th scope="col" className={thClass}>
                Shared
              </th>
              {syncing && (
                <>
                  <SortHeader
                    label="Size"
                    sort={sort}
                    ascending="size-asc"
                    descending="size-desc"
                    onSortChange={onSortChange}
                  />
                  <th scope="col" className={thClass}>
                    Kept in
                  </th>
                </>
              )}
              <SortHeader
                label="Last edited"
                sort={sort}
                ascending="edited-asc"
                descending="edited-desc"
                onSortChange={onSortChange}
              />
              <th scope="col" className={cn(thClass, actionsClass)}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((project) => (
              <tr key={project.id} className={cn(selected.has(project.id) && "[&>td]:bg-mark")}>
                <td className={cn(tdClass, checkClass)}>
                  <Checkbox
                    aria-label={`Select ${project.name}`}
                    checked={selected.has(project.id)}
                    onCheckedChange={(checked) => toggleProject(project.id, checked)}
                  />
                </td>
                <td className={tdClass}>
                  <span className="flex items-center gap-2">
                    <Link to={`/p/${project.id}`} className="font-semibold text-text no-underline hover:underline">
                      {project.name}
                    </Link>
                    {isSideBySide(project) && <SideBySideTag />}
                  </span>
                </td>
                <td className={tdClass}>
                  <ReleaseLines lines={getProjectReleaseLines(project)} />
                </td>
                <td className={cn(tdClass, "py-1.25")}>
                  <ShareCell project={project} share={shares[project.id]} />
                </td>
                {syncing && (
                  <>
                    <td className={cn(mutedCellClass, getProjectBytes(project) > maxProjectBytes && "text-err")}>
                      {formatBytes(getProjectBytes(project))}
                    </td>
                    <td className={cn(tdClass, "py-1.25")}>
                      <CloudLocation project={project} cloudSync={cloudSync} />
                    </td>
                  </>
                )}
                <td className={mutedCellClass}>
                  <time dateTime={project.updatedAt}>{formatEditedLabel(project.updatedAt, now)}</time>
                </td>
                <td className={cn(tdClass, actionsClass, "py-1.25")}>
                  <RowActions project={project} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer}
    </div>
  );
}
