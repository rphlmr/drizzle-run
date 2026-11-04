import { DIALECTS } from "@drizzle-run/core/catalog";
import type { RunManifestTarget } from "@drizzle-run/core/manifest";
import { useActorRef, useSelector } from "@xstate/react";
import type { FormEvent } from "react";
import { Fragment, useEffect, useEffectEvent, useState, ViewTransition } from "react";
import {
  createBrowserRouter,
  Link,
  matchPath,
  Outlet,
  RouterContextProvider,
  useLocation,
  useNavigate,
  type DataRouter,
  type RouteObject,
} from "react-router";
import { fromPromise } from "xstate";

import { appServicesContext, useAppServices, type AppServices } from "./app-services";
import { AuthProvider, loadSession, SESSION_PATH, shouldReloadSession, signOut } from "./auth/auth-provider";
import { CloudSyncBanners } from "./cloud/cloud-sync-banners";
import { CloudSyncProvider, useCloudSync } from "./cloud/cloud-sync-provider";
import { isCloudSyncActive } from "./cloud/cloud-usage";
import { communityAction, CommunityPage, loadCommunityPage, LoadingCommunityPage } from "./community/community-page";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { ConnectProvider, useConnectWorkspace } from "./connect/connect-provider";
import { EmbedOfficialExample, EmbedSnapshot } from "./embed/embed-playground";
import {
  ExampleGallery,
  loadExampleGallery,
  LoadingExampleGallery,
  shouldReloadExampleGallery,
} from "./examples/example-gallery";
import { ExamplePage, loadExamplePage } from "./examples/example-page";
import { describeProjectDeletion } from "./home/delete-description";
import { DrizzleRain } from "./home/drizzle-rain";
import { LoadingProjects, loadProjectShares, ProjectsLayout, ProjectsPage } from "./home/projects-page";
import { WelcomePage } from "./home/welcome-page";
import { getErrorText } from "./lib/error-text";
import { cn } from "./lib/utils";
import { myShareAction } from "./my-shares/my-share-actions";
import { LoadingMyShares, loadMyShares, MySharesPage } from "./my-shares/my-shares-section";
import { ChooseReleaseDialog } from "./project/choose-release-dialog";
import { ProjectImportActorProvider } from "./project/import-actor";
import { projectImportMachine, type ProjectImportSave, type QueuedRetiredImport } from "./project/import-machine";
import { NewProjectDialog } from "./project/new-project-dialog";
import { ProjectSwitcher } from "./project/project-switcher";
import {
  chooseImportRelease,
  chooseRelease,
  createProject,
  createSideBySideProject,
  duplicateProject,
  editProject,
  type ProjectRecord,
} from "./project/projects";
import { shareConsentClass } from "./share/share-dialog";
import { loadSharePublication } from "./share/share-publication-loader";
import { LoadingSnapshot, loadSharedSnapshot, SharedSnapshot } from "./share/shared-playground";
import { SiteHeader } from "./shell/site-header";
import { LocalProjectStorage, type ShareLinkRecord } from "./store/storage";
import { AppShell } from "./ui/app-shell";
import { errorBannerClass, noticeBannerClass } from "./ui/banners";
import { FieldNote } from "./ui/field";
import { leaveOnPurpose } from "./ui/leave-guard";
import { download } from "./ui/results";
import { RouteErrorPage } from "./ui/route-error-page";
import { useAppUpdated } from "./ui/use-app-updated";
import { useWorkspace, type WorkspaceContext } from "./workspace/context";
import { toArrivalState, type ProjectArrival } from "./workspace/project-arrival";
import { saveProjectIntro, shouldReloadProjectIntro } from "./workspace/project-arrival-notice";
import { loadProjectPage, LoadingProject, NotFoundPage, ProjectPage } from "./workspace/project-page";
import { storeSaveStateShortLabels, type StoreSaveState } from "./workspace/save-state";
import {
  createWorkspaceDialogsMachine,
  getAskedRelease,
  getImportReport,
  type ImportReport,
} from "./workspace/workspace-dialogs-machine";
import { waitUntilSaved, workspaceMachine } from "./workspace/workspace-machine";

const sharedSnapshotRoute = {
  loader: loadSharedSnapshot,
  Component: SharedSnapshot,
  HydrateFallback: LoadingSnapshot,
};

/**
 * Create the app's router
 *
 * The embed pages stand alone; every other page sits inside the Connect layout. `/session` is a resource route
 * for fetchers, with no page. Loaders and actions read `services` from the router context, and an error
 * they or a page throw shows the route error page.
 */
export function createAppRouter(services: AppServices): DataRouter {
  return createBrowserRouter(createAppRoutes(), {
    getContext: () => {
      const context = new RouterContextProvider();

      context.set(appServicesContext, services);

      return context;
    },
  });
}

/** The app's route tree, as `createAppRouter` serves it. */
export function createAppRoutes(): RouteObject[] {
  return [
    {
      ErrorBoundary: RouteErrorPage,
      children: [
        { path: "/embed/:snapshotId", Component: EmbedSnapshot },
        { path: "/embed/examples/:example", Component: EmbedOfficialExample },
        { path: "/embed/examples/:example/:step", Component: EmbedOfficialExample },
        { path: SESSION_PATH, loader: loadSession, action: signOut, shouldRevalidate: shouldReloadSession },
        { path: "/resources/share-publication/:linkId", loader: loadSharePublication },
        {
          Component: ConnectLayout,
          children: [
            { path: "/s/:snapshotId", ...sharedSnapshotRoute },
            {
              Component: Workspace,
              children: [
                {
                  Component: SiteLayout,
                  children: [
                    { index: true, Component: WelcomePage },
                    {
                      path: "projects",
                      Component: ProjectsLayout,
                      children: [
                        {
                          index: true,
                          loader: loadProjectShares,
                          Component: ProjectsPage,
                          HydrateFallback: LoadingProjects,
                        },
                        {
                          path: "shares",
                          loader: loadMyShares,
                          action: myShareAction,
                          Component: MySharesPage,
                          HydrateFallback: LoadingMyShares,
                        },
                      ],
                    },
                    {
                      path: "examples",
                      loader: loadExampleGallery,
                      shouldRevalidate: shouldReloadExampleGallery,
                      Component: ExampleGallery,
                      HydrateFallback: LoadingExampleGallery,
                    },
                    {
                      path: "community",
                      loader: loadCommunityPage,
                      action: communityAction,
                      Component: CommunityPage,
                      HydrateFallback: LoadingCommunityPage,
                    },
                    { path: "*", Component: NotFoundPage },
                  ],
                },
                { path: "examples/:slug", loader: loadExamplePage, Component: ExamplePage },
                {
                  path: "p/:projectId",
                  loader: loadProjectPage,
                  action: saveProjectIntro,
                  shouldRevalidate: shouldReloadProjectIntro,
                  Component: ProjectPage,
                  HydrateFallback: LoadingProject,
                },
              ],
            },
          ],
        },
      ],
    },
  ];
}

/**
 * One AI chat link and one sign-in state for shared links and the workspace, so a shared link lends itself read only.
 * Embeds never connect and never read the session.
 */
function ConnectLayout() {
  const { settings } = useAppServices();

  return (
    <AuthProvider>
      <ConnectProvider settings={settings}>
        <Outlet />
      </ConnectProvider>
    </AuthProvider>
  );
}

/**
 * The site pages: home, My projects, the gallery, Community and not-found, under one site header
 *
 * The header stays mounted while a page's first load shows its loading screen and between site pages, so a menu
 * opened in it stays open. The home draws its dot grid and rain behind the header. A move to another site page
 * crossfades the page under the header; a search change or a fetcher update on the same page does not.
 */
function SiteLayout() {
  const workspace = useWorkspace();
  const { pathname } = useLocation();
  const home = pathname === "/";
  const sitePage = pathname.split("/")[1];

  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-1 flex-col",
        home &&
          "overflow-clip bg-[radial-gradient(var(--dot-grid)_1px,transparent_1.2px)] bg-size-[18px_18px] text-[15px]",
      )}
    >
      {home && <DrizzleRain />}
      <SiteHeader />
      {/* Keyed by site page, so another page is an exit and an enter, and a tab or filter change never animates. */}
      <ViewTransition key={sitePage} update="none">
        <Outlet context={workspace} />
      </ViewTransition>
    </div>
  );
}

function formatProjectCount(projects: number): string {
  return projects === 1 ? "1 project" : `${projects} projects`;
}

/**
 * The import's banner text: what it added, what it left out as declined, what still waits for a release, what could
 * not be read, and releases that moved
 *
 * Empty for one project added as it was written, which simply opens.
 */
function describeImport({ added, pending, declined, skipped, releaseNotes }: ImportReport): string {
  const total = added + pending + declined + skipped.length;
  const nothingAdded = added === 0 && pending === 0;
  const summary =
    total <= 1
      ? ""
      : nothingAdded
        ? "Nothing was imported."
        : added === 0
          ? `${formatProjectCount(pending)} will be imported once a release is chosen.`
          : `Imported ${formatProjectCount(added)}${pending > 0 ? `, and ${pending} more once a release is chosen` : ""}.`;
  const parts = [
    summary,
    declined > 0 ? `${formatProjectCount(declined)} left out, as you chose.` : "",
    ...skipped,
    ...releaseNotes,
  ];

  return parts.filter((part) => part !== "").join(" ");
}

function getStarterName(target: RunManifestTarget) {
  return `My ${DIALECTS[target.dialect].label} project`;
}

const writeExport = (
  items: readonly ProjectRecord[],
  filename: string | undefined,
  links?: ReadonlyMap<string, ShareLinkRecord>,
) => {
  const records = items.map((item) => {
    const link = links?.get(item.id);
    return link ? { ...item, shareLink: link } : item;
  });

  if (records.length === 1 && filename === undefined) {
    download(`${items[0].name}.json`, records[0]);
  } else {
    download(filename ?? "drizzle-run-projects.json", records);
  }
};

/** Owns the local project store and the dialogs every page can open. */
function Workspace() {
  const [storage] = useState(() => new LocalProjectStorage());
  const actor = useActorRef(workspaceMachine, { input: { storage } });
  const state = useSelector(actor, (snapshot) => snapshot);
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState("");
  const appUpdated = useAppUpdated();

  useEffect(
    () => storage.onExternalChange((change) => actor.send({ type: "projects.merge", ...change })),
    [actor, storage],
  );

  useEffect(() => {
    const flush = () => actor.send({ type: "save.flush" });
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") {
        flush();
      }
    };

    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flushWhenHidden);

    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [actor]);

  // WebKit drops IndexedDB writes started in pagehide, so a pending save also listens to
  // beforeunload, which runs while the page still has time. Only then, to keep the back/forward cache.
  const pendingSave = state.matches("debouncing");
  useEffect(() => {
    if (!pendingSave) {
      return;
    }

    const flush = () => actor.send({ type: "save.flush" });
    window.addEventListener("beforeunload", flush);

    return () => window.removeEventListener("beforeunload", flush);
  }, [actor, pendingSave]);

  const projects = state.context.projects;
  const change = (next: ProjectRecord[]) => actor.send({ type: "projects.change", projects: next });
  const update = (next: ProjectRecord) =>
    change(actor.getSnapshot().context.projects.map((item) => (item.id === next.id ? next : item)));
  const add = (next: ProjectRecord, options: { open?: boolean; arrival?: ProjectArrival } = {}) => {
    actor.send({ type: "projects.add", projects: [next] });

    if (options.open ?? true) {
      leaveOnPurpose(() => {
        void navigate(`/p/${next.id}`, options.arrival ? { state: toArrivalState(options.arrival) } : undefined);
      });
    }
  };
  const loading = state.matches("loading") || state.matches("loadError");
  const storeSaveState: StoreSaveState = state.matches("saved")
    ? "saved"
    : state.matches("saving")
      ? "saving"
      : state.matches("saveError")
        ? "save_error"
        : "unsaved";

  const report = (cause: unknown) => setError(getErrorText(cause));

  const renameProject = useEffectEvent((project: ProjectRecord, name: string) => {
    const current = actor.getSnapshot().context.projects.find((item) => item.id === project.id);

    if (current) {
      update(editProject(current, undefined, name));
    }
  });
  const deleteProjects = useEffectEvent((deleted: readonly ProjectRecord[]) => {
    const removed = new Set(deleted.map((item) => item.id));

    change(actor.getSnapshot().context.projects.filter((item) => !removed.has(item.id)));

    const openId = matchPath("/p/:projectId", location.pathname)?.params.projectId;

    if (openId !== undefined && removed.has(openId)) {
      void navigate("/projects");
    }
  });
  const [dialogsMachine] = useState(() =>
    createWorkspaceDialogsMachine({
      renameProject: async ({ project, name }) => renameProject(project, name),
      deleteProjects: async ({ projects: deleted }) => deleteProjects(deleted),
      findShareLinks: async ({ projects: exported }) => {
        const found = await Promise.all(exported.map((item) => storage.shareLink(item.id).catch(() => undefined)));

        return new Map(
          exported.flatMap((item, index) => {
            const link = found[index];
            return link ? [[item.id, link] as const] : [];
          }),
        );
      },
      writeExport: ({ projects: exported, filename, links, includeLinks }) =>
        writeExport(exported, filename, includeLinks ? links : undefined),
    }),
  );
  const dialogs = useActorRef(dialogsMachine);
  const dialogState = useSelector(dialogs, (snapshot) => snapshot);
  const dialogOpen =
    !dialogState.matches({ dialogs: "closed" }) && !dialogState.matches({ dialogs: "exportLookingUp" });
  const askedRelease = getAskedRelease(dialogState, projects);
  const importReport = getImportReport(dialogState);
  const importNotice = importReport === null ? "" : describeImport(importReport);
  const importUnreadable = (importReport?.skipped.length ?? 0) > 0;

  useEffect(() => {
    if (!loading) {
      dialogs.send({ type: "releases.load", stored: storage.getRetiredPairProjects() });
    }
  }, [dialogs, loading, storage]);

  const cloudSync = useCloudSync({
    storage,
    projects,
    loaded: !loading,
    flushProjects: async () => {
      actor.send({ type: "save.flush" });
      await waitUntilSaved(actor, actor.getSnapshot().context.revision);
    },
    putProject: async (next) => {
      const current = actor.getSnapshot().context.projects.find((item) => item.id === next.id);

      // The cloud copy replaces this one, so it saves above the local revision another tab may hold.
      if (current) {
        update({ ...next, revision: Math.max(next.revision, current.revision + 1) });
      } else {
        add(next, { open: false });
      }

      // Cloud sync records the copy as matched only once it is stored, so it saves without the edit pause.
      actor.send({ type: "save.flush" });
      await waitUntilSaved(actor, actor.getSnapshot().context.revision);

      return actor.getSnapshot().context.projects.find((item) => item.id === next.id) ?? null;
    },
    // Cloud sync forgets a project's row before it leaves, so the project is saved gone before it settles.
    removeProjects: async (ids) => {
      deleteProjects(actor.getSnapshot().context.projects.filter((item) => ids.includes(item.id)));
      actor.send({ type: "save.flush" });
      await waitUntilSaved(actor, actor.getSnapshot().context.revision);
    },
  });

  const addChosenImport = (queued: QueuedRetiredImport, chosen: ProjectRecord) => {
    if (queued.shareLink !== undefined) {
      storage.saveShareLink(chosen.id, queued.shareLink).catch(report);
    }

    add(chosen, { open: queued.opens });
  };

  const addImported = useEffectEvent(({ projects: imported, opens }: ProjectImportSave) => {
    const [only] = imported;

    if (only === undefined) {
      return;
    }

    if (opens) {
      add(only);
      return;
    }

    actor.send({ type: "projects.add", projects: imported });
    leaveOnPurpose(() => {
      void navigate("/projects");
    });
  });

  const importer = useActorRef(
    projectImportMachine.provide({
      actors: {
        restoreShareKey: fromPromise(async ({ input }) => {
          await Promise.all(input.map(({ projectId, link }) => storage.saveShareLink(projectId, link)));
        }),
        save: fromPromise(async ({ input }) => addImported(input)),
      },
    }),
  );

  useEffect(() => {
    const subscription = importer.on("import.done", ({ projects: imported, skipped, retired, releaseNotes }) => {
      dialogs.send({ type: "import.done", added: imported.length, retired, skipped, releaseNotes });
    });

    return () => subscription.unsubscribe();
  }, [dialogs, importer]);

  const exportProjects = (items: readonly ProjectRecord[], filename?: string) =>
    dialogs.send({ type: "export.start", projects: items, ...(filename === undefined ? {} : { filename }) });

  const context: WorkspaceContext = {
    storage,
    projects,
    loading,
    saveState: storeSaveState,
    cloudSync,
    banners: (
      <>
        {appUpdated && (
          <output className={noticeBannerClass}>
            Drizzle Run was updated. Reload to keep going.
            <Button variant="outline" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </output>
        )}
        {(state.matches("loadError") || state.matches("saveError")) && (
          <div className={errorBannerClass} role="alert">
            {state.context.error} Your unsaved content stays in memory.{" "}
            <Button variant="outline" onClick={() => actor.send({ type: "store.retry" })}>
              Retry
            </Button>
          </div>
        )}
        <CloudSyncBanners cloudSync={cloudSync} />
        {state.context.recovered.length > 0 && (
          <div className={noticeBannerClass} role="status">
            <span>
              A project was removed from this browser. Your pending edits are kept in Local copies:{" "}
              {state.context.recovered.map((project, index) => (
                <Fragment key={project.id}>
                  {index > 0 && ", "}
                  <Link className="font-semibold underline" to={`/p/${project.id}`}>
                    {project.name}
                  </Link>
                </Fragment>
              ))}
            </span>
            <Button variant="ghost" onClick={() => actor.send({ type: "recovered.dismiss" })}>
              Dismiss
            </Button>
          </div>
        )}
        {state.context.replaced.length > 0 && (
          <div className={errorBannerClass} role="alert">
            <span>
              Another tab saved{" "}
              {state.context.replaced.map((project, index) => (
                <Fragment key={project.id}>
                  {index > 0 && ", "}
                  <b className="font-semibold">{project.name}</b>
                </Fragment>
              ))}{" "}
              first, so this tab now shows that copy. The edits made here since were not saved.
            </span>
            <Button variant="ghost" onClick={() => actor.send({ type: "replaced.dismiss" })}>
              Dismiss
            </Button>
          </div>
        )}
        {storage.recoverableCount > 0 && (
          <output className={errorBannerClass}>
            {storage.recoverableCount} saved project{storage.recoverableCount === 1 ? "" : "s"} could not be opened.
            Their original records remain preserved in this browser.{" "}
            <Button
              variant="outline"
              onClick={() => download("drizzle-run-recoverable-projects.json", storage.getRecoverableRecords())}
            >
              Export preserved records
            </Button>
          </output>
        )}
        {importNotice &&
          !dialogOpen &&
          (importUnreadable ? (
            <div className={errorBannerClass} role="alert">
              {importNotice}
              <Button variant="ghost" onClick={() => dialogs.send({ type: "import_report.dismiss" })}>
                Dismiss
              </Button>
            </div>
          ) : (
            <output className={noticeBannerClass}>
              {importNotice}
              <Button variant="ghost" onClick={() => dialogs.send({ type: "import_report.dismiss" })}>
                Dismiss
              </Button>
            </output>
          ))}
        {error && !dialogOpen && (
          <div className={errorBannerClass} role="alert">
            {error}
            <Button variant="ghost" onClick={() => setError("")}>
              Dismiss
            </Button>
          </div>
        )}
      </>
    ),
    renderSwitcher: (current) => (
      <ProjectSwitcher
        projects={projects}
        current={current}
        disabled={loading}
        saveLabel={storeSaveStateShortLabels[storeSaveState]}
        onSelect={(next) => {
          void navigate(`/p/${next.id}`);
        }}
        onCreate={() => context.openCreate()}
        onRename={() => current && context.rename(current)}
        onDuplicate={() => current && context.duplicate(current)}
        onExport={() => current && exportProjects([current])}
        onDelete={() => current && context.remove([current])}
      />
    ),
    add,
    update,
    reportError: setError,
    openCreate: () => {
      setError("");
      dialogs.send({ type: "create.open" });
    },
    quickCreate: (target) => {
      try {
        add(createProject(getStarterName(target), target), { arrival: { kind: "created" } });
      } catch (cause) {
        report(cause);
      }
    },
    rename: (project) => {
      setError("");
      dialogs.send({ type: "rename.open", project });
    },
    duplicate: (project) =>
      add(duplicateProject(project), { arrival: { kind: "duplicated", originalHref: `/p/${project.id}` } }),
    exportProjects,
    remove: (items) => {
      if (items.length > 0) {
        setError("");
        dialogs.send({ type: "delete.open", projects: items });
      }
    },
  };

  const submitDialog = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    dialogs.send({ type: "dialog.submit" });
  };
  const closeDialog = (isOpen: boolean) => {
    if (!isOpen) {
      dialogs.send({ type: "dialog.close" });
    }
  };

  useConnectWorkspace(() => ({
    projects: () => actor.getSnapshot().context.projects,
    update,
    // The project opens in another tab from the chat's link, so it is saved before the link shows.
    create: async (next) => {
      add(next, { open: false });
      actor.send({ type: "save.flush" });
      await waitUntilSaved(actor, actor.getSnapshot().context.revision);
    },
  }));

  const deleteOpen = dialogState.matches({ dialogs: "delete" });
  const renameOpen = dialogState.matches({ dialogs: "rename" });
  const deleting = deleteOpen ? dialogState.context.projects : [];
  const deletingCloud = deleting.filter((item) => cloudSync.isCloudProject(item.id));
  const projectExport = dialogState.matches({ dialogs: "exportConfirm" }) ? dialogState.context.export : undefined;

  return (
    <CloudSyncProvider value={cloudSync}>
      <AppShell>
        <Outlet context={context} />
        <ProjectImportActorProvider actor={importer}>
          <NewProjectDialog
            open={dialogState.matches({ dialogs: "create" })}
            onOpenChange={closeDialog}
            offerCloud={isCloudSyncActive(cloudSync)}
            onCreate={(projectName, projectTarget, choice, keptIn) => {
              const created =
                choice.kind === "pair"
                  ? createSideBySideProject(
                      projectName,
                      choice.targets,
                      choice.tupleIds,
                      choice.files,
                      choice.guestFlavors,
                      choice.names,
                    )
                  : createProject(projectName, projectTarget, choice.tupleId, choice.guestFlavor);

              add(created, { arrival: { kind: "created" } });

              if (keptIn === "cloud") {
                cloudSync.moveToCloud(created.id);
              }

              dialogs.send({ type: "dialog.close" });
            }}
          />
        </ProjectImportActorProvider>
        {askedRelease?.kind === "stored" && (
          <ChooseReleaseDialog
            key={askedRelease.project.id}
            project={askedRelease.project}
            onChoose={(choices) => {
              const chosen = chooseRelease(askedRelease.project, choices);

              // Another tab may have answered first: its copy stays, with one id per project.
              if (!actor.getSnapshot().context.projects.some((project) => project.id === chosen.id)) {
                add(chosen);
              }

              dialogs.send({ type: "release.answer", id: askedRelease.project.id, answer: "chosen" });
            }}
            onLater={() => dialogs.send({ type: "release.answer", id: askedRelease.project.id, answer: "later" })}
          />
        )}
        {askedRelease?.kind === "import" && (
          <ChooseReleaseDialog
            key={askedRelease.project.id}
            project={askedRelease.project}
            laterLabel="Don't import"
            onChoose={(choices) => {
              addChosenImport(askedRelease.project, chooseImportRelease(askedRelease.project, choices));
              dialogs.send({ type: "release.answer", id: askedRelease.project.id, answer: "chosen" });
            }}
            onLater={() => dialogs.send({ type: "release.answer", id: askedRelease.project.id, answer: "later" })}
          />
        )}
        <Dialog open={projectExport !== undefined} onOpenChange={closeDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {projectExport !== undefined && projectExport.projects.length > 1
                  ? `Export ${projectExport.projects.length} projects`
                  : "Export project"}
              </DialogTitle>
              <DialogDescription>
                {projectExport?.links.size === 1
                  ? "One of these projects has a shared link."
                  : "Some of these projects have shared links."}{" "}
                The export leaves them out unless you include them.
              </DialogDescription>
            </DialogHeader>
            <label className={shareConsentClass}>
              <Checkbox
                checked={dialogState.context.includeLinks}
                onCheckedChange={(include) => dialogs.send({ type: "links.toggle", include })}
              />
              Include share links
            </label>
            {dialogState.context.includeLinks && (
              <FieldNote>
                An imported copy can push changes to them when you sign in with the account that shared them.
              </FieldNote>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => dialogs.send({ type: "dialog.close" })}>
                Cancel
              </Button>
              <Button onClick={() => dialogs.send({ type: "dialog.submit" })}>Export JSON</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={renameOpen || deleteOpen} onOpenChange={closeDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {deleteOpen
                  ? deleting.length === 1
                    ? "Delete project?"
                    : `Delete ${deleting.length} projects?`
                  : "Rename project"}
              </DialogTitle>
              <DialogDescription>
                {deleteOpen
                  ? describeProjectDeletion({
                      names: deleting.map((item) => item.name),
                      cloudCount: deletingCloud.length,
                      sharedCount: dialogState.context.sharedCount,
                    })
                  : "Give this project a name."}
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={submitDialog}>
              {renameOpen && (
                <label>
                  Project name
                  <Input
                    value={dialogState.context.name}
                    onChange={(event) => dialogs.send({ type: "name.change", name: event.target.value })}
                    required
                    maxLength={160}
                  />
                </label>
              )}
              {dialogState.context.error && <p role="alert">{dialogState.context.error}</p>}
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => dialogs.send({ type: "dialog.close" })}>
                  Cancel
                </Button>
                <Button variant={deleteOpen ? "destructive" : "default"} type="submit">
                  {!deleteOpen
                    ? "Save"
                    : deletingCloud.length > 0
                      ? "Delete everywhere"
                      : deleting.length === 1
                        ? "Delete project"
                        : `Delete ${deleting.length} projects`}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </AppShell>
    </CloudSyncProvider>
  );
}
