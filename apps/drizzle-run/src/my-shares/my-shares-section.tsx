import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import {
  Form,
  Link,
  Navigate,
  useFetcher,
  useLoaderData,
  useRevalidator,
  useSubmit,
  type LoaderFunctionArgs,
} from "react-router";

import { appServicesContext, type AppServices } from "../app-services";
import { useAuth } from "../auth/auth-provider";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { formatEditedLabel } from "../home/project-list";
import { useAppendedPages } from "../lib/use-appended-pages";
import { cn } from "../lib/utils";
import type { ProjectRecord } from "../project/projects";
import { CopyLinkButton } from "../share/copy-link-button";
import { FieldError } from "../ui/field";
import { ReleaseLines, type ReleaseLine } from "../ui/release-lines";
import { SideBySideTag } from "../ui/side-by-side-tag";
import { PHONE_QUERY, useMediaQuery } from "../ui/use-media-query";
import { useWorkspace } from "../workspace/context";
import { MySharesError, type MyShare, type MySharesPage, type ShareListingState } from "./contract";
import { MyShareActions, MyShareName, useShareEdit } from "./my-share-actions";
import { ShareVisibilityBadge, type ShareVisibility } from "./share-visibility";

/** The My shares tab; its loader reads the first page, or with a `cursor` parameter the page after it. */
export const MY_SHARES_PATH = "/projects/shares";

/**
 * One page of the account's links for the cursor and search it was asked for, or why it failed
 *
 * `localProjects` holds, by link id, the project in this browser each link shares.
 */
export type MySharesData = {
  cursor: string | undefined;
  search: string;
  localProjects: Readonly<Record<string, string>>;
} & ({ status: "loaded"; page: MySharesPage } | { status: "failed"; error: string } | { status: "session_ended" });

/** Load one page of the signed-in account's links. A session the Worker refused is `session_ended`. */
export async function loadMyShares({ request, context }: LoaderFunctionArgs): Promise<MySharesData> {
  const params = new URL(request.url).searchParams;
  const cursor = params.get("cursor") ?? undefined;
  const search = params.get("q") ?? "";
  const { myShares, localShares } = context.get(appServicesContext);
  const localProjectsRead = readLocalProjects(localShares);

  try {
    const page = await myShares.fetchMySharesPage({ cursor, search: search.trim(), signal: request.signal });

    return { cursor, search, localProjects: await localProjectsRead, status: "loaded", page };
  } catch (cause) {
    const localProjects = await localProjectsRead;

    if (cause instanceof MySharesError && cause.code === "sign_in_required") {
      return { cursor, search, localProjects, status: "session_ended" };
    }

    return {
      cursor,
      search,
      localProjects,
      status: "failed",
      error: cause instanceof Error ? cause.message : "Your shares could not be loaded.",
    };
  }
}

/** The project in this browser each link shares, by link id; an unreadable store knows none. */
async function readLocalProjects(localShares: AppServices["localShares"]): Promise<Record<string, string>> {
  try {
    const links = await localShares.listShareLinks();

    return Object.fromEntries(links.map(({ projectId, link }) => [link.linkId, projectId]));
  } catch {
    return {};
  }
}

const emptyPage: MySharesPage = { shares: [], nextCursor: undefined };

const listingVisibility: Record<ShareListingState, ShareVisibility> = {
  listed: "community",
  unlisted: "link_only",
  removed: "removed",
};

function VisibilityBadge({ share }: { share: MyShare }) {
  return (
    <ShareVisibilityBadge
      visibility={share.listing === null ? "link_only" : listingVisibility[share.listing.state]}
      bugRepro={share.listing?.topic === "bug-repros"}
    />
  );
}

const thClass = cn(
  "border-b border-border bg-surface-2 px-2 py-[9px] text-left font-medium whitespace-nowrap text-muted",
);
const tdClass = cn("border-b border-surface-2 p-2");
const mutedCellClass = cn(tdClass, "whitespace-nowrap text-muted");
const frameClass = cn("flex flex-col overflow-hidden rounded-lg border border-border bg-surface");

function getShareReleaseLines(share: MyShare): ReleaseLine[] {
  return share.pairs.map((pair) => ({
    name: pair.name,
    dialect: pair.dialect,
    ormVersion: pair.orm,
    kitVersion: pair.kit,
    guestFlavor: pair.guestFlavor,
  }));
}

/** The project in this browser each link shares, by link id. */
type ShareSources = Readonly<Record<string, ProjectRecord>>;

function getShareSources(
  localProjects: MySharesData["localProjects"],
  projects: readonly ProjectRecord[],
): ShareSources {
  const projectsById = new Map(projects.map((project) => [project.id, project]));

  return Object.fromEntries(
    Object.entries(localProjects).flatMap(([linkId, projectId]) => {
      const project = projectsById.get(projectId);

      return project === undefined ? [] : [[linkId, project]];
    }),
  );
}

function ShareSource({ source }: { source: ProjectRecord | undefined }) {
  if (source === undefined) {
    return <span className="text-[12px] text-muted">Not in this browser</span>;
  }

  return <span className="truncate text-[12px] text-muted">From {source.name}</span>;
}

interface SharesViewProps {
  shares: MyShare[];
  sources: ShareSources;
  now: Date;
}

interface ShareRowProps {
  share: MyShare;
  source: ProjectRecord | undefined;
  now: Date;
}

function SharesList({ shares, sources, now }: SharesViewProps) {
  return (
    <ul aria-label="My shares">
      {shares.map((share) => (
        <ShareListItem key={share.id} share={share} source={sources[share.id]} now={now} />
      ))}
    </ul>
  );
}

function ShareListItem({ share, source, now }: ShareRowProps) {
  const edit = useShareEdit(share);

  return (
    <li className="flex items-center gap-1 border-b border-surface-2 pr-2">
      <MyShareName
        share={share}
        source={source}
        edit={edit}
        className="flex min-h-touch min-w-0 flex-1 items-center gap-2.5 py-3 pl-3.5 text-text no-underline"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-semibold">{share.title}</span>
            {share.pairs.length === 2 && <SideBySideTag />}
          </span>
          <ShareSource source={source} />
          <ReleaseLines lines={getShareReleaseLines(share)} className="text-[13px]" />
          <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-[13px] text-muted">
            <VisibilityBadge share={share} />
            updated {formatEditedLabel(share.updatedAt, now).toLocaleLowerCase()}
          </span>
        </span>
      </MyShareName>
      <CopyLinkButton linkId={share.id} title={share.title} variant="icon" />
      <MyShareActions share={share} source={source} edit={edit} />
    </li>
  );
}

function SharesTable({ shares, sources, now }: SharesViewProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[14px]" aria-label="My shares">
        <thead>
          <tr>
            <th scope="col" className={cn(thClass, "pl-3.5")}>
              Name
            </th>
            <th scope="col" className={thClass}>
              Database and Drizzle
            </th>
            <th scope="col" className={thClass}>
              Visibility
            </th>
            <th scope="col" className={thClass}>
              Last updated
            </th>
            <th scope="col" className={cn(thClass, "pr-3.5")}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {shares.map((share) => (
            <ShareTableRow key={share.id} share={share} source={sources[share.id]} now={now} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ShareTableRow({ share, source, now }: ShareRowProps) {
  const edit = useShareEdit(share);

  return (
    <tr>
      <td className={cn(tdClass, "pl-3.5")}>
        <span className="flex items-center gap-2">
          <MyShareName
            share={share}
            source={source}
            edit={edit}
            className="font-semibold text-text no-underline hover:underline"
          >
            {share.title}
          </MyShareName>
          {share.pairs.length === 2 && <SideBySideTag />}
        </span>
        <ShareSource source={source} />
      </td>
      <td className={tdClass}>
        <ReleaseLines lines={getShareReleaseLines(share)} />
      </td>
      <td className={tdClass}>
        <VisibilityBadge share={share} />
      </td>
      <td className={mutedCellClass}>
        <time dateTime={share.updatedAt}>{formatEditedLabel(share.updatedAt, now)}</time>
      </td>
      <td className={cn(tdClass, "pr-3.5")}>
        <span className="flex items-center justify-end gap-1">
          <CopyLinkButton linkId={share.id} title={share.title} variant="icon" />
          <MyShareActions share={share} source={source} edit={edit} />
        </span>
      </td>
    </tr>
  );
}

function MySharesHeading({ search }: { search?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 max-phone:gap-3.5">
      <h1
        id="my-shares-title"
        className="font-display text-[30px] font-extrabold tracking-[-0.02em] max-phone:text-[24px]"
      >
        My shares
      </h1>
      {search}
    </div>
  );
}

/** Searches the account's shares by name as the owner types, keeping one history entry. */
function SharesSearch({ search }: { search: string }) {
  const submit = useSubmit();

  return (
    <search className="ml-auto max-phone:ml-0 max-phone:w-full">
      <Form>
        <input
          className="h-9 w-60 rounded-md border border-border bg-surface px-3 text-text focus-visible:border-accent-text focus-visible:outline-transparent max-phone:h-touch max-phone:w-full max-phone:rounded-[12px] max-phone:px-3.5"
          type="search"
          name="q"
          placeholder="Search shares"
          aria-label="Search shares"
          defaultValue={search}
          onChange={(event) => void submit(event.currentTarget.form, { replace: true })}
        />
      </Form>
    </search>
  );
}

function SharesSkeleton() {
  return (
    <div className={cn(frameClass, "gap-2 p-3.5")} aria-busy="true" aria-label="Loading your shares">
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-5 w-1/2" />
    </div>
  );
}

/** The My shares tab while its first page loads with the app. */
export function LoadingMyShares() {
  return (
    <section className="flex min-w-0 flex-col gap-2.5 max-phone:gap-3.5" aria-labelledby="my-shares-title">
      <MySharesHeading />
      <SharesSkeleton />
    </section>
  );
}

/**
 * My shares: the links the signed-in account shared, newest first, with who can find each one
 *
 * Without an account it goes back to My projects. A session the Worker refuses reads the session again.
 */
export function MySharesPage() {
  const auth = useAuth();
  const workspace = useWorkspace();
  const firstPage = useLoaderData<typeof loadMyShares>();
  const revalidator = useRevalidator();
  const more = useFetcher<typeof loadMyShares>();
  const phone = useMediaQuery(PHONE_QUERY);
  const [now] = useState(() => new Date());
  const signedIn = auth.user !== null;
  const sessionEnded = firstPage.status === "session_ended" || more.data?.status === "session_ended";
  const reportSessionEnded = useEffectEvent(auth.reportSessionEnded);

  useEffect(() => {
    if (signedIn && sessionEnded) {
      reportSessionEnded();
    }
  }, [signedIn, sessionEnded]);

  const nextPage =
    more.data?.status === "loaded" && more.data.cursor !== undefined && more.data.search === firstPage.search
      ? { cursor: more.data.cursor, page: more.data.page }
      : undefined;
  const { shares, nextCursor } = useAppendedPages(firstPage.status === "loaded" ? firstPage.page : emptyPage, nextPage);
  const sources = getShareSources(firstPage.localProjects, workspace.projects);
  const loadingMore = more.state === "loading";
  const moreError =
    !loadingMore && more.data?.status === "failed" && more.data.cursor === nextCursor ? more.data.error : "";

  if (!signedIn && auth.status !== "loading" && auth.status !== "redirecting") {
    return <Navigate to="/projects" replace />;
  }

  const loadMore = (cursor: string) => {
    const params = new URLSearchParams({ cursor });

    if (firstPage.search !== "") {
      params.set("q", firstPage.search);
    }

    void more.load(`${MY_SHARES_PATH}?${params.toString()}`);
  };

  return (
    <section className="flex min-w-0 flex-col gap-2.5 max-phone:gap-3.5" aria-labelledby="my-shares-title">
      <MySharesHeading
        search={
          (shares.length > 0 || firstPage.search !== "") && (
            <SharesSearch key={firstPage.search} search={firstPage.search} />
          )
        }
      />
      {!signedIn || firstPage.status === "session_ended" || revalidator.state === "loading" ? (
        <SharesSkeleton />
      ) : firstPage.status === "failed" ? (
        <div className="flex flex-col items-start gap-3">
          <FieldError>{firstPage.error}</FieldError>
          <Button variant="outline" onClick={() => void revalidator.revalidate()}>
            Try again
          </Button>
        </div>
      ) : shares.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-10 text-muted">
          {firstPage.search === "" ? (
            <>
              <p>No shares yet. Open a project and choose Share to get a link.</p>
              <Button variant="outline" nativeButton={false} render={<Link to="/projects" className="no-underline" />}>
                Go to My projects
              </Button>
            </>
          ) : (
            <p>No share matches “{firstPage.search}”.</p>
          )}
        </div>
      ) : (
        <div className={frameClass}>
          {phone ? (
            <SharesList shares={shares} sources={sources} now={now} />
          ) : (
            <SharesTable shares={shares} sources={sources} now={now} />
          )}
          {(nextCursor !== undefined || moreError !== "") && (
            <div className="flex min-h-13 flex-wrap items-center gap-3 px-3.5 py-2 text-[13px] text-muted">
              {moreError && <FieldError>{moreError}</FieldError>}
              {nextCursor !== undefined && (
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  disabled={loadingMore}
                  onClick={() => loadMore(nextCursor)}
                >
                  {loadingMore ? "Loading…" : "Show more shares"}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
