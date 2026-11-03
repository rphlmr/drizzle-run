import type { GuideManifest } from "@drizzle-run/core/guide";
import { useEffect, useState, type ReactNode } from "react";
import {
  Link,
  useLoaderData,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
  type LoaderFunctionArgs,
} from "react-router";

import { appServicesContext } from "../app-services";
import { useOptionalCloudSync } from "../cloud/cloud-sync-provider";
import { getProjectLocation } from "../cloud/project-location";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import type { ConnectViewOptions } from "../connect/connect-provider";
import { getGuideConversation, getProjectConversation } from "../connect/conversations";
import { TrustProjectDialog } from "../connect/trust-project-dialog";
import { listExamples } from "../examples/catalog";
import { findGuide, getGuideProgressSetting, GUIDE_SEEN_SETTING, isPairGuide } from "../guides/catalog";
import { GuidedPlayground } from "../guides/guided-playground";
import { ProjectView } from "../project/project-view";
import {
  getProjectScope,
  isOneVersion,
  isSideBySide,
  transitionProjectTrust,
  type OneVersionProject,
  type ProjectRecord,
  type SideBySideProject,
  type ProjectTrustEvent,
} from "../project/projects";
import { AppHeader } from "../shell/app-header";
import { ForkDialog } from "../side-by-side/fork-dialog";
import { SideBySideView } from "../side-by-side/side-by-side-view";
import { EmptyState } from "../ui/empty-state";
import { KindBadge } from "../ui/kind-badge";
import { SiteFooter } from "../ui/site-footer";
import { useWorkspace } from "./context";
import { readProjectArrival, type ProjectArrival } from "./project-arrival";
import { loadProjectIntro, ProjectArrivalNotice } from "./project-arrival-notice";
import { ProjectLinkNotFound } from "./project-link-not-found";

/** Load how this browser left the intro, and the file the project last showed; a read that fails reads as none. */
export async function loadProjectPage(args: LoaderFunctionArgs) {
  const { settings } = args.context.get(appServicesContext);
  const [{ intro }, rememberedFile] = await Promise.all([
    loadProjectIntro(args),
    settings.preference(args.params.projectId ?? "").catch(() => undefined),
  ]);

  return { intro, rememberedFile };
}

/** The `/p/:projectId` page: the project in its view, walked by its guide when `?guide=` names one, or not found. */
export function ProjectPage() {
  const workspace = useWorkspace();
  const { projectId } = useParams();
  const [search] = useSearchParams();
  const project = workspace.projects.find((item) => item.id === projectId);
  const [shownProjectId, setShownProjectId] = useState<string | undefined>(undefined);

  if (project && shownProjectId !== project.id) {
    setShownProjectId(project.id);
  }

  const guide = findGuide(search.get("guide") ?? "");
  const { intro, rememberedFile } = useLoaderData<typeof loadProjectPage>();
  const arrival = useProjectArrival();
  const cloudSync = useOptionalCloudSync();
  const notice = project && arrival && (
    <ProjectArrivalNotice
      key={arrival.navigation}
      arrival={arrival.arrival}
      projectName={project.name}
      intro={intro}
      location={cloudSync ? getProjectLocation(cloudSync, project.id) : "local"}
    />
  );

  if (project && guide && isOneVersion(project) && !isPairGuide(guide)) {
    return <GuidedProject key={project.id} project={project} guide={guide} />;
  }

  if (project && isSideBySide(project)) {
    return (
      <>
        <SideBySideProjectView key={project.id} project={project} rememberedFile={rememberedFile} />
        {notice}
      </>
    );
  }

  if (project) {
    return (
      <>
        <OneVersionProjectView key={project.id} project={project} rememberedFile={rememberedFile} />
        {notice}
      </>
    );
  }

  if (workspace.loading) {
    return <LoadingProject />;
  }

  return <ProjectLinkNotFound deleted={projectId !== undefined && shownProjectId === projectId} />;
}

/** The project page while the local projects load. */
export function LoadingProject() {
  const workspace = useWorkspace();

  return (
    <>
      <AppHeader leading={workspace.renderSwitcher()} />
      {workspace.banners}
      <EmptyState>
        <Skeleton className="h-7 w-56" />
        <p>
          <output>Loading local projects…</output>
        </p>
      </EmptyState>
    </>
  );
}

/** An arrival, and the navigation and project address it came with. */
interface HeldArrival {
  navigation: string;
  pathname: string;
  arrival: ProjectArrival;
}

/**
 * How this page was reached: after a create, a Duplicate or a Fork, read from the navigation's history state
 *
 * The page stays mounted from one project to the next, as a Duplicate opens its copy from the original's page, so the
 * arrival is held per navigation and only for its project. The state is then cleared, so a reload or Back to this
 * entry opens the project without the notice again.
 */
function useProjectArrival(): HeldArrival | null {
  const location = useLocation();
  const navigate = useNavigate();
  const [held, setHeld] = useState<HeldArrival | null>(null);
  const incoming = readProjectArrival(location.state);

  if (incoming && held?.navigation !== location.key) {
    setHeld({ navigation: location.key, pathname: location.pathname, arrival: incoming });
  }

  useEffect(() => {
    if (location.state !== null) {
      void navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    }
  }, [location.pathname, location.search, location.state, navigate]);

  return held?.pathname === location.pathname ? held : null;
}

/**
 * How a workspace project lends itself to the AI chat
 *
 * Someone else's project reads only until the user trusts it: the chat note and the project menu ask, and the
 * returned dialog confirms. The user's own projects are trusted and carry no trust controls.
 */
function useProjectConnect(project: ProjectRecord): { connect: ConnectViewOptions; trustDialog: ReactNode } {
  const workspace = useWorkspace();
  const [confirming, setConfirming] = useState(false);
  const applyTrust = (event: ProjectTrustEvent) => {
    const next = transitionProjectTrust(project, event);

    if (next !== project) {
      workspace.update(next);
    }
  };
  const connect: ConnectViewOptions = {
    scope: getProjectScope(project),
    conversation: getProjectConversation(project.id),
    ...(project.origin === "community"
      ? {
          trust: {
            state: project.trust,
            requestTrust: () => setConfirming(true),
            untrust: () => applyTrust({ type: "project.untrust" }),
          },
        }
      : {}),
  };
  const trustDialog = project.origin === "community" && (
    <TrustProjectDialog
      open={confirming}
      onOpenChange={setConfirming}
      onConfirm={() => {
        setConfirming(false);
        applyTrust({ type: "project.trust" });
      }}
    />
  );

  return { connect, trustDialog };
}

/** A side-by-side project. */
function SideBySideProjectView({ project, rememberedFile }: { project: SideBySideProject; rememberedFile?: string }) {
  const workspace = useWorkspace();
  const { connect, trustDialog } = useProjectConnect(project);

  return (
    <>
      <SideBySideView
        project={project}
        rememberedFile={rememberedFile}
        storage={workspace.storage}
        update={workspace.update}
        saveState={workspace.saveState}
        reportError={workspace.reportError}
        leading={workspace.renderSwitcher(project)}
        banner={workspace.banners}
        connect={connect}
        onExportProjects={() => workspace.exportProjects(workspace.projects, "drizzle-run-projects.json")}
        onDuplicate={() => workspace.duplicate(project)}
      />
      {trustDialog}
    </>
  );
}

/** A one-version project, with "Duplicate" and "Fork as side by side" in its more menu. */
function OneVersionProjectView({ project, rememberedFile }: { project: OneVersionProject; rememberedFile?: string }) {
  const workspace = useWorkspace();
  const [forking, setForking] = useState(false);
  const { connect, trustDialog } = useProjectConnect(project);

  return (
    <>
      <ProjectView
        project={project}
        rememberedFile={rememberedFile}
        storage={workspace.storage}
        update={workspace.update}
        saveState={workspace.saveState}
        reportError={workspace.reportError}
        leading={workspace.renderSwitcher(project)}
        banner={workspace.banners}
        onExportProjects={() => workspace.exportProjects(workspace.projects, "drizzle-run-projects.json")}
        onDuplicate={() => workspace.duplicate(project)}
        onForkSideBySide={() => setForking(true)}
        connect={connect}
      />
      {trustDialog}
      <ForkDialog
        project={project}
        open={forking}
        onOpenChange={setForking}
        onFork={(fork) => {
          setForking(false);
          workspace.add(fork, { open: true });
        }}
      />
    </>
  );
}

/** A first project walked by its guide (`?guide=first-run`); the project is saved like any other. */
function GuidedProject({ project, guide }: { project: OneVersionProject; guide: GuideManifest }) {
  const workspace = useWorkspace();
  const [, setSearch] = useSearchParams();
  const nextExample = listExamples().find((example) => example.guide);

  const markGuideSeen = () => {
    void workspace.storage.writeSetting(GUIDE_SEEN_SETTING, true).catch(() => undefined);
  };
  const closeGuide = () => {
    markGuideSeen();
    setSearch(
      (params) => {
        params.delete("guide");
        return params;
      },
      { replace: true },
    );
  };

  return (
    <GuidedPlayground
      guide={guide}
      project={project}
      update={workspace.update}
      storage={workspace.storage}
      settings={workspace.storage}
      progressKey={getGuideProgressSetting(guide.id, project.id)}
      conversation={getGuideConversation(guide.id, project.id)}
      saveState={workspace.saveState}
      banner={workspace.banners}
      projectActions
      renderLeading={() => (
        <span className="flex min-w-0 items-center gap-2">
          {workspace.renderSwitcher(project)}
          <KindBadge tone="outline" header className="max-phone:hidden">
            Guided
          </KindBadge>
        </span>
      )}
      leave="skip"
      lockedMessage={(stepsLeft) =>
        `Read-only for ${stepsLeft} more step${stepsLeft === 1 ? "" : "s"}. Skip the guide to edit now.`
      }
      done={{
        text: "Edit any file and run it. Changes are saved in this browser.",
        actions: (
          <Button variant="sticker" className="h-10" onClick={closeGuide}>
            Close guide
          </Button>
        ),
        next: nextExample && { title: nextExample.title, href: `/examples/${nextExample.slug}` },
      }}
      onLeave={closeGuide}
      onDone={markGuideSeen}
    />
  );
}

/**
 * The site page for an address that matches nothing, with a way back to My projects
 *
 * Draws no header: the site layout draws it, and a page outside that layout puts a `SiteHeader` above it.
 */
export function NotFoundPage({
  title = "Page not found",
  message = "This address doesn't match a page in Drizzle Run.",
}: {
  title?: string;
  message?: string;
}) {
  const workspace = useWorkspace();

  return (
    <>
      {workspace.banners}
      <EmptyState>
        <h1>{title}</h1>
        <p>{message}</p>
        <Button variant="outline" nativeButton={false} render={<Link to="/projects" />}>
          Back to projects
        </Button>
      </EmptyState>
      <SiteFooter />
    </>
  );
}
