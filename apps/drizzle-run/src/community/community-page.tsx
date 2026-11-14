import { ChevronDownIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import {
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigate,
  useNavigation,
  useRevalidator,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import * as z from "zod/mini";

import { appServicesContext } from "../app-services";
import { useAuth } from "../auth/auth-provider";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Skeleton } from "../components/ui/skeleton";
import { getErrorText } from "../lib/error-text";
import { useAppendedPages } from "../lib/use-appended-pages";
import { cn } from "../lib/utils";
import { SiteMain } from "../shell/site-header";
import { Chip } from "../ui/chip";
import { FieldError } from "../ui/field";
import { ToggleGroup } from "../ui/toggle-group";
import { useWorkspace } from "../workspace/context";
import { CommunityCard } from "./community-card";
import { COMMUNITY_NOTICE_SETTING } from "./community-open";
import {
  CommunityDialectSchema,
  CommunityShareIdSchema,
  CommunitySortSchema,
  type CommunityDialect,
  type CommunityPage as CommunitySharesPage,
  type CommunityQuery,
  type CommunityShare,
  type CommunitySort,
} from "./contract";
import { localReportedShares } from "./reported-shares";
import { getCommunitySharePath } from "./share-labels";
import { CommunityTopicSchema, DEFAULT_COMMUNITY_TOPIC, type CommunityTopic } from "./topics";

const DATABASES: readonly { value: "all" | CommunityDialect; label: string }[] = [
  { value: "all", label: "Any database" },
  { value: "postgresql", label: "PostgreSQL" },
  { value: "sqlite", label: "SQLite" },
];

const TOPIC_FILTERS: readonly { value: CommunityTopic; label: string }[] = [
  { value: "playground", label: "All" },
  { value: "bug-repros", label: "Bug repros" },
];

const SORTS: readonly { value: CommunitySort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

const SEARCH_PAUSE_MS = 250;

const CommunityQueryParamsSchema = z.object({
  q: z.catch(z.string(), ""),
  topic: z.catch(CommunityTopicSchema, DEFAULT_COMMUNITY_TOPIC),
  db: z.catch(z.optional(CommunityDialectSchema), undefined),
  sort: z.catch(CommunitySortSchema, "newest"),
});

function readQuery(params: URLSearchParams): CommunityQuery {
  const { q, topic, db, sort } = CommunityQueryParamsSchema.parse({
    q: params.get("q"),
    topic: params.get("topic"),
    db: params.get("db"),
    sort: params.get("sort"),
  });

  return { search: q, topic, dialect: db, sort };
}

function writeQuery(query: CommunityQuery): URLSearchParams {
  const params = new URLSearchParams();

  if (query.search !== "") {
    params.set("q", query.search);
  }

  if (query.topic !== DEFAULT_COMMUNITY_TOPIC) {
    params.set("topic", query.topic);
  }

  if (query.dialect !== undefined) {
    params.set("db", query.dialect);
  }

  if (query.sort !== "newest") {
    params.set("sort", query.sort);
  }

  return params;
}

/** One page of Community shares for the filters, or why it failed; `cursor` is the cursor it was asked for. */
export type CommunityPageData = {
  query: CommunityQuery;
  cursor: string | undefined;
} & ({ status: "loaded"; page: CommunitySharesPage } | { status: "failed"; error: string });

/**
 * Load one page of the Community list
 *
 * The filters come from the URL; a `cursor` parameter loads the page after it, for Show more.
 */
export async function loadCommunityPage({ request, context }: LoaderFunctionArgs): Promise<CommunityPageData> {
  const { community } = context.get(appServicesContext);
  const { searchParams } = new URL(request.url);
  const query = readQuery(searchParams);
  const cursor = searchParams.get("cursor") ?? undefined;

  try {
    const page = await community.fetchCommunityPage({
      query,
      cursor,
      signal: request.signal,
    });

    return { query, cursor, status: "loaded", page };
  } catch (cause) {
    return {
      query,
      cursor,
      status: "failed",
      error: cause instanceof Error ? cause.message : "Community shares could not be loaded.",
    };
  }
}

const CommunityActionFormSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("report"), shareId: CommunityShareIdSchema }),
  z.object({ intent: z.literal("hide_notice") }),
]);

/** What the action did: reported a share, hid the notice, or why it failed. */
export type CommunityActionResult =
  | { status: "reported" }
  | { status: "notice_hidden" }
  | { status: "failed"; error: string };

/**
 * Report a share, or hide the notice
 *
 * `report` sends the share to the moderators and remembers in this browser that it was reported. `hide_notice`
 * remembers "Don't show this again for community shares" in this browser.
 */
export async function communityAction({ request, context }: ActionFunctionArgs): Promise<CommunityActionResult> {
  const { community, settings } = context.get(appServicesContext);
  const form = CommunityActionFormSchema.safeParse(Object.fromEntries(await request.formData()));

  if (!form.success) {
    return { status: "failed", error: "This share cannot be reported." };
  }

  if (form.data.intent === "hide_notice") {
    await settings.writeSetting(COMMUNITY_NOTICE_SETTING, true).catch(() => undefined);

    return { status: "notice_hidden" };
  }

  try {
    await community.reportCommunityShare({
      shareId: form.data.shareId,
      signal: request.signal,
    });
  } catch (cause) {
    return { status: "failed", error: getErrorText(cause) };
  }

  localReportedShares.add(form.data.shareId);

  return { status: "reported" };
}

const emptyPage: CommunitySharesPage = { shares: [], nextCursor: undefined };

const shareGridClass = cn("grid grid-cols-[repeat(auto-fill,minmax(min(100%,440px),1fr))] gap-3");

function LoadingShares() {
  return (
    <ul className={shareGridClass} role="list" aria-label="Loading community shares" aria-busy="true">
      {Array.from({ length: 6 }, (_, index) => (
        <li key={index}>
          <Skeleton className="h-35.5 w-full rounded-lg" />
        </li>
      ))}
    </ul>
  );
}

/** The Community page while its first load runs. */
export function LoadingCommunityPage() {
  return (
    <SiteMain className="gap-4.5 pt-7">
      <LoadingShares />
    </SiteMain>
  );
}

/** Community shares: playgrounds their owners chose to list, filtered and paged by the Worker. */
export function CommunityPage() {
  const signedIn = useAuth().status === "signedIn";
  const workspace = useWorkspace();
  const loaded = useLoaderData<typeof loadCommunityPage>();
  const location = useLocation();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const more = useFetcher<typeof loadCommunityPage>();
  const pendingList = navigation.state === "loading" && navigation.location.pathname === location.pathname;
  const leavingPage = navigation.state !== "idle" && navigation.location.pathname !== location.pathname;
  const query = readQuery(new URLSearchParams(pendingList ? navigation.location.search : location.search));
  const moreData =
    more.data !== undefined && writeQuery(more.data.query).toString() === writeQuery(loaded.query).toString()
      ? more.data
      : undefined;
  const nextPage =
    moreData?.status === "loaded" && moreData.cursor !== undefined
      ? { cursor: moreData.cursor, page: moreData.page }
      : undefined;
  const { shares, nextCursor } = useAppendedPages(loaded.status === "loaded" ? loaded.page : emptyPage, nextPage);
  const loadingMore = more.state === "loading";
  const moreError =
    !loadingMore && moreData?.status === "failed" && moreData.cursor === nextCursor ? moreData.error : "";
  const retrying = revalidator.state === "loading";
  const searchInput = useRef<HTMLInputElement>(null);
  const searchPause = useRef<ReturnType<typeof setTimeout>>(undefined);
  const filtered = query.search.trim() !== "" || query.topic !== DEFAULT_COMMUNITY_TOPIC || query.dialect !== undefined;

  useEffect(() => () => clearTimeout(searchPause.current), []);

  // A search that lands after a navigation away starts would replace it, and the page would stay here.
  useEffect(() => {
    if (leavingPage) {
      clearTimeout(searchPause.current);
      searchPause.current = undefined;
    }
  }, [leavingPage]);

  // The field holds what is typed until the pause; a search set elsewhere, such as Back or Clear filters, replaces it.
  useEffect(() => {
    if (searchInput.current !== null && searchPause.current === undefined) {
      searchInput.current.value = query.search;
    }
  }, [query.search]);

  const change = (next: Partial<CommunityQuery>) => {
    clearTimeout(searchPause.current);
    searchPause.current = undefined;

    const search = searchInput.current?.value ?? query.search;

    void navigate({ search: writeQuery({ ...query, search, ...next }).toString() }, { replace: true });
  };

  const searchAfterPause = () => {
    clearTimeout(searchPause.current);
    searchPause.current = setTimeout(() => change({}), SEARCH_PAUSE_MS);
  };

  const openShare = (share: CommunityShare) => {
    clearTimeout(searchPause.current);
    searchPause.current = undefined;
    void navigate(getCommunitySharePath(share));
  };

  const showMore = () => {
    if (nextCursor === undefined) {
      return;
    }

    const params = writeQuery(loaded.query);

    params.set("cursor", nextCursor);
    void more.load(`${location.pathname}?${params.toString()}`);
  };

  const clearFilters = () => {
    if (searchInput.current !== null) {
      searchInput.current.value = "";
    }

    change({ topic: DEFAULT_COMMUNITY_TOPIC, dialect: undefined });
  };

  return (
    <>
      {workspace.banners}
      <SiteMain className="gap-4.5 pt-7">
        <div className="flex items-end gap-6 max-phone:flex-col max-phone:items-start max-phone:gap-2">
          <div className="flex flex-1 flex-col gap-2">
            <h1 className="font-display text-[24px] font-semibold tracking-[-0.03em]">Community shares</h1>
            <p className="text-[13px] text-muted">Explore what others are building with Drizzle.</p>
          </div>
          <p className="max-w-60 text-right text-[12px]/[1.5] text-muted max-phone:text-left">
            {signedIn ? "Add yours: share a project" : "Add yours: sign in with GitHub, share a project"}
            <br className="max-phone:hidden" /> and pick <b className="font-semibold text-text">Community</b>.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-40 flex-1 max-phone:basis-full sm:max-w-90">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
              aria-hidden="true"
            />
            <input
              className="h-9 w-full rounded-md border border-border bg-surface pr-3 pl-9 text-[13px] text-text focus-visible:border-accent-text focus-visible:outline-transparent max-phone:h-touch"
              type="search"
              placeholder="Search shares"
              aria-label="Search community shares"
              maxLength={100}
              ref={searchInput}
              defaultValue={query.search}
              onChange={searchAfterPause}
            />
          </div>
          <fieldset
            className="flex min-w-auto flex-wrap gap-1.5 max-phone:w-full max-phone:scrollbar-none max-phone:flex-nowrap max-phone:overflow-x-auto"
            aria-label="Topic"
          >
            {TOPIC_FILTERS.map((topic) => (
              <Chip
                key={topic.value}
                pressed={query.topic === topic.value}
                onClick={() => change({ topic: topic.value })}
              >
                {topic.label}
              </Chip>
            ))}
          </fieldset>
          <ToggleGroup
            label="Database"
            options={DATABASES}
            value={query.dialect ?? "all"}
            onChange={(value) => {
              change({ dialect: value === "all" ? undefined : value });
            }}
            className="ml-auto max-phone:ml-0 max-phone:flex-1"
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" className="h-9 rounded-md px-3 font-normal max-phone:h-touch" />}
              aria-label={`Sort: ${SORTS.find((sort) => sort.value === query.sort)?.label ?? ""}`}
            >
              {SORTS.find((sort) => sort.value === query.sort)?.label}
              <ChevronDownIcon className="size-3.5" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto">
              <DropdownMenuRadioGroup
                value={query.sort}
                onValueChange={(value) => {
                  const sort = SORTS.find((item) => item.value === value)?.value;

                  if (sort !== undefined) {
                    change({ sort });
                  }
                }}
              >
                {SORTS.map((sort) => (
                  <DropdownMenuRadioItem key={sort.value} value={sort.value}>
                    {sort.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {loaded.status === "failed" && !retrying && !pendingList ? (
          <div className="my-6 flex flex-col items-start gap-3">
            <FieldError>{loaded.error}</FieldError>
            <Button variant="outline" onClick={() => void revalidator.revalidate()}>
              Try again
            </Button>
          </div>
        ) : (pendingList || retrying) && shares.length === 0 ? (
          <LoadingShares />
        ) : shares.length === 0 ? (
          <div className="my-6 flex flex-col items-start gap-3 text-muted">
            {filtered ? (
              <>
                <p>No share matches these filters.</p>
                <Button variant="outline" onClick={clearFilters}>
                  Clear filters
                </Button>
              </>
            ) : (
              <p>
                {signedIn
                  ? "No shares yet. Share a project and pick Community to add the first one."
                  : "No shares yet. Sign in with GitHub, share a project and pick Community to add the first one."}
              </p>
            )}
          </div>
        ) : (
          <>
            {/* role="list" because Safari drops list semantics from a list without bullets. */}
            <ul className={shareGridClass} role="list" aria-label="Community shares" aria-busy={pendingList}>
              {shares.map((share) => (
                <li key={share.id} className="flex min-w-0">
                  <CommunityCard share={share} onOpen={openShare} />
                </li>
              ))}
            </ul>
            {(nextCursor !== undefined || moreError !== "") && (
              <div className="flex flex-col items-center gap-2">
                {moreError && <FieldError>{moreError}</FieldError>}
                {nextCursor !== undefined && (
                  <Button variant="outline" disabled={loadingMore} onClick={showMore}>
                    {loadingMore ? "Loading…" : "Show more shares"}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </SiteMain>
    </>
  );
}
