import { useActorRef, useSelector } from "@xstate/react";
import { InfoIcon, UnlinkIcon } from "lucide-react";
import { useEffectEvent, useMemo, useState } from "react";
import {
  Link,
  useLoaderData,
  useLocation,
  useNavigate,
  useParams,
  useRevalidator,
  type LoaderFunctionArgs,
} from "react-router";

import { appServicesContext, useAppServices } from "../app-services";
import { useAuth } from "../auth/auth-provider";
import { CommunityOwner } from "../community/community-card";
import { COMMUNITY_NOTICE_SETTING, CommunityOpen } from "../community/community-open";
import { Button, buttonVariants } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { getSharedConversation } from "../connect/conversations";
import { ChooseReleasePanel } from "../project/choose-release-dialog";
import { ProjectView } from "../project/project-view";
import {
  createProjectFromManifest,
  isSideBySide,
  listRetiredReleases,
  openRetiredSnapshot,
  openSharedSnapshot,
  toCommunityProject,
  type ProjectRecord,
} from "../project/projects";
import { AppHeader } from "../shell/app-header";
import { SideBySideView } from "../side-by-side/side-by-side-view";
import { LocalProjectStorage, VolatileProjectStorage } from "../store/storage";
import { AppShell } from "../ui/app-shell";
import { errorBannerClass } from "../ui/banners";
import { EmptyState } from "../ui/empty-state";
import { ForkButton } from "../ui/fork-button";
import { leaveOnPurpose } from "../ui/leave-guard";
import { SnapshotNote } from "../ui/snapshot-note";
import { toArrivalState } from "../workspace/project-arrival";
import {
  isRetiredPairPlayground,
  PlaygroundIdSchema,
  PlaygroundNotFoundError,
  type LoadedPlayground,
} from "./playgrounds-contract";
import { createSnapshotForkMachine, requestFork } from "./snapshot-fork-machine";

/** How long a fork waits to learn whether the signed-in account owns the link. */
const ownershipCheckTimeoutMs = 10_000;

const linkButtonClass = "h-10 rounded-md px-4 text-[14px] font-semibold";

/** A shared playground, or why it could not open. */
export type SharedSnapshotData =
  | {
      status: "loaded";
      playground: LoadedPlayground;
      /** True when this browser hid the notice that a listed link opens with. */
      noticeDismissed: boolean;
    }
  | { status: "not_found"; error: string }
  | { status: "failed"; error: string };

/** Load the `/s/:snapshotId` page's playground. */
export async function loadSharedSnapshot({
  params,
  context,
  request,
}: LoaderFunctionArgs): Promise<SharedSnapshotData> {
  const { playgrounds, settings } = context.get(appServicesContext);
  const id = params.snapshotId ?? "";

  if (!PlaygroundIdSchema.safeParse(id).success) {
    return { status: "not_found", error: "This shared playground does not exist." };
  }

  try {
    const playground = await playgrounds.getPlaygroundSnapshot({ id, signal: request.signal });
    const noticeDismissed =
      playground.community !== null &&
      (await settings.readSetting(COMMUNITY_NOTICE_SETTING).catch(() => undefined)) === true;

    return { status: "loaded", playground, noticeDismissed };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : "The playground could not be loaded.";

    return cause instanceof PlaygroundNotFoundError ? { status: "not_found", error } : { status: "failed", error };
  }
}

/** Open a published playground as a temporary editable copy at `/s/:snapshotId`. */
export function SharedSnapshot() {
  const { snapshotId = "" } = useParams();

  return <SnapshotWorkspace key={snapshotId} snapshotId={snapshotId} />;
}

function SnapshotWorkspace({ snapshotId }: { snapshotId: string }) {
  const { playgrounds } = useAppServices();
  const loaded = useLoaderData<typeof loadSharedSnapshot>();
  const revalidator = useRevalidator();
  const playground = loaded.status === "loaded" ? loaded.playground : undefined;
  const [draft, setDraft] = useState<{ source: LoadedPlayground; project: ProjectRecord }>();
  const opened = useMemo(() => playground && openSharedSnapshot(playground), [playground]);
  const project = draft && draft.source === playground ? draft.project : opened;
  const [temporaryStorage] = useState(() => new VolatileProjectStorage());
  const [localStorage] = useState(() => new LocalProjectStorage());
  const [reported, setReported] = useState<{ source: LoadedPlayground; error: string }>();
  const error = reported !== undefined && reported.source === playground ? reported.error : "";
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();
  const [noticeClosed, setNoticeClosed] = useState(false);

  const update = (next: ProjectRecord) => {
    if (playground) {
      setDraft({ source: playground, project: next });
    }
  };
  const reportError = (next: string) => {
    if (playground) {
      setReported({ source: playground, error: next });
    }
  };

  /**
   * Saves a fork of the shared playground in this browser, untrusted: it stays someone else's code, so the AI reads it
   * only until the user trusts it. The fork button opens it; `fork_project` leaves this page in front.
   */
  const saveFork = useEffectEvent(async (name: string): Promise<ProjectRecord> => {
    if (!project) {
      throw new Error("The shared playground is still opening. Fork it once it shows.");
    }

    const projects = await localStorage.load();
    const forked = toCommunityProject(createProjectFromManifest(name, structuredClone(project.manifest)));
    await localStorage.save([...projects, forked]);

    const owned =
      auth.status === "signedIn" &&
      playground !== undefined &&
      (await playgrounds
        .fetchLinkOwnership({ linkId: snapshotId, signal: AbortSignal.timeout(ownershipCheckTimeoutMs) })
        .catch(() => false));

    if (owned && playground) {
      await localStorage
        .saveShareLink(forked.id, { linkId: snapshotId, publishedAt: playground.updatedAt })
        .catch((cause: unknown) => {
          console.error("Keeping the fork's link to the user's own share failed", cause);
        });
    }

    return forked;
  });
  const [forkMachine] = useState(() => createSnapshotForkMachine({ saveFork: (name) => saveFork(name) }));
  const forkActor = useActorRef(forkMachine);
  const forking = useSelector(forkActor, (snapshot) => snapshot.matches("saving"));
  const forkError = useSelector(forkActor, (snapshot) => snapshot.context.error);

  const fork = async () => {
    if (!project) {
      return;
    }

    const forked = await requestFork(forkActor, { name: project.name, open: true });

    leaveOnPurpose(() => {
      void navigate(`/p/${forked.id}`, {
        state: toArrivalState({ kind: "forked", originalHref: window.location.pathname }),
      });
    });
  };

  if (loaded.status === "not_found") {
    return <SharedNotFound />;
  }

  if (loaded.status === "failed" && revalidator.state === "loading") {
    return <LoadingSnapshot />;
  }

  if (loaded.status === "failed") {
    return (
      <LoadFailure
        title="Could not open playground"
        error={loaded.error}
        onRetry={() => void revalidator.revalidate()}
      />
    );
  }

  const retiredReleases =
    playground && isRetiredPairPlayground(playground) ? listRetiredReleases(playground.snapshot.manifest) : undefined;

  if (playground && isRetiredPairPlayground(playground) && retiredReleases && !project) {
    return (
      <AppShell>
        <AppHeader />
        <EmptyState>
          <ChooseReleasePanel
            name={playground.snapshot.name}
            manifest={playground.snapshot.manifest}
            releases={retiredReleases}
            secondary={
              <Link to="/" className={buttonVariants({ variant: "outline" })}>
                Back to projects
              </Link>
            }
            onChoose={(choices) =>
              setDraft({
                source: playground,
                project: openRetiredSnapshot(playground.snapshot, retiredReleases, choices),
              })
            }
          />
        </EmptyState>
      </AppShell>
    );
  }

  if (!playground || !project) {
    return <LoadingSnapshot />;
  }

  const sharedPair =
    isRetiredPairPlayground(playground) && playground.retiredPair.releaseLine === "next"
      ? playground.retiredPair
      : undefined;
  const community = playground.community;
  const ownShare =
    community !== null && auth.user !== null && auth.user.login.toLowerCase() === community.owner.login.toLowerCase();
  const showNotice = community !== null && !loaded.noticeDismissed && auth.status !== "loading" && !ownShare;
  const leaveCommunityShare = () => {
    if (location.key === "default") {
      void navigate("/community");
    } else {
      void navigate(-1);
    }
  };

  const shared = {
    storage: temporaryStorage,
    update,
    saveState: "temporary" as const,
    unsavedCopy: project !== opened,
    reportError,
    leading: (
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate font-semibold">{project.name}</span>
        <span className="shrink-0 rounded-pill bg-surface-2 px-2 py-0.75 text-[12px] font-medium whitespace-nowrap text-muted max-phone:hidden">
          Shared snapshot
        </span>
      </span>
    ),
    fork: <ForkButton onFork={() => void fork().catch(() => undefined)} forking={forking} />,
    forkBeforeLeaving: () => requestFork(forkActor, { name: project.name, open: false }),
    banner: (
      <>
        <SnapshotNote>
          <InfoIcon aria-hidden="true" />
          <span>
            {community && (
              <>
                Listed in Community by{" "}
                <span className="inline-flex align-middle">
                  <CommunityOwner owner={community.owner} />
                </span>
                .{" "}
              </>
            )}
            {playground.description && (
              <>
                <span className="font-semibold text-text" data-slot="share-description">
                  {playground.description}
                </span>{" "}
              </>
            )}
            This is a temporary copy. Shared code runs only when you press Run. Fork it to keep your edits.
            {sharedPair &&
              ` It was shared with orm ${sharedPair.ormVersion} · kit ${sharedPair.kitVersion}, which Drizzle Run no longer ships.`}
          </span>
          {forkError && <span role="alert">{forkError}</span>}
        </SnapshotNote>
        {error && (
          <div className={errorBannerClass} role="alert">
            {error}
            <Button variant="ghost" onClick={() => setReported(undefined)}>
              Dismiss
            </Button>
          </div>
        )}
      </>
    ),
    projectActions: false,
    connect: {
      scope: "snapshot" as const,
      conversation: getSharedConversation(snapshotId),
      fork: (name: string) => requestFork(forkActor, { name, open: false }),
    },
  };

  return (
    <AppShell>
      {isSideBySide(project) ? (
        <SideBySideView key={playground.digest} project={project} {...shared} />
      ) : (
        <ProjectView key={playground.digest} project={project} {...shared} />
      )}
      {community && showNotice && (
        <CommunityOpen
          share={community}
          open={!noticeClosed}
          onOpenCopy={() => setNoticeClosed(true)}
          onCancel={leaveCommunityShare}
        />
      )}
    </AppShell>
  );
}

/** The shared page while its first load or a retry runs. */
export function LoadingSnapshot() {
  return (
    <AppShell>
      <AppHeader />
      <EmptyState>
        <Skeleton className="h-7 w-56" />
        <p>
          <output>Loading shared snapshot…</output>
        </p>
      </EmptyState>
    </AppShell>
  );
}

function LoadFailure({ title, error, onRetry }: { title: string; error: string; onRetry?: () => void }) {
  return (
    <AppShell>
      <AppHeader />
      <EmptyState>
        <h1>{title}</h1>
        <p role="alert">{error}</p>
        {onRetry && <Button onClick={onRetry}>Retry</Button>}
        <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
          Back to projects
        </Button>
      </EmptyState>
    </AppShell>
  );
}

/**
 * The shared page when its link opens nothing, drawn like `ProjectLinkNotFound`
 *
 * A 404 cannot tell a removed link from a mistyped one, so the wording allows both.
 */
function SharedNotFound() {
  return (
    <AppShell>
      <AppHeader />
      {/* m-auto rather than centering the main, so a card taller than a phone scrolls instead of clipping its top */}
      <main className="flex min-h-0 flex-1 overflow-y-auto bg-bg bg-[radial-gradient(var(--border)_1px,transparent_1.2px)] bg-size-[18px_18px] px-6 py-6 max-phone:px-4">
        <section
          aria-labelledby="shared-not-found"
          className="m-auto flex w-140 max-w-full flex-col gap-4 rounded-[18px] border-[1.5px] border-card-border bg-surface p-7 shadow-sticker-card max-phone:p-5"
        >
          <span
            className="grid size-11 place-items-center rounded-[12px] border-[1.5px] border-run-border bg-lime text-on-lime"
            aria-hidden="true"
          >
            <UnlinkIcon className="size-5" />
          </span>
          <div className="flex flex-col gap-2">
            <h1
              id="shared-not-found"
              className="m-0 font-display text-[32px]/[1.1] font-extrabold tracking-[-0.02em] max-phone:text-[26px]"
            >
              This shared playground can&apos;t be found
            </h1>
            <p className="m-0 text-[15px]/[1.6] text-muted">
              It may have been removed, or the address may be incomplete or mistyped.
            </p>
          </div>
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0" role="list">
            <li className="flex gap-3 rounded-[12px] bg-mark px-3.5 py-3 text-[14px]/normal max-phone:flex-col max-phone:gap-1">
              <b className="shrink-0 font-semibold">Got it from someone?</b>
              <span>Ask them to check the link, or to send a working Share link.</span>
            </li>
            <li className="flex gap-3 rounded-[12px] bg-surface-2 px-3.5 py-3 text-[14px]/normal max-phone:flex-col max-phone:gap-1">
              <b className="shrink-0 font-semibold">Typed or pasted it?</b>
              <span>Check that the whole address was copied.</span>
            </li>
          </ul>
          <div className="flex flex-wrap gap-2.5 pt-1">
            <Button variant="sticker" className={linkButtonClass} nativeButton={false} render={<Link to="/examples" />}>
              Browse examples
            </Button>
            <Button
              variant="outline"
              className={linkButtonClass}
              nativeButton={false}
              render={<Link to="/community" />}
            >
              Community
            </Button>
            <Button variant="outline" className={linkButtonClass} nativeButton={false} render={<Link to="/projects" />}>
              My projects
            </Button>
          </div>
        </section>
      </main>
    </AppShell>
  );
}
