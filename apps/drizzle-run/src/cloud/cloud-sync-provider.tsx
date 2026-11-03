import { useActorRef, useSelector } from "@xstate/react";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fromPromise } from "xstate";

import { useAppServices } from "../app-services";
import { useAuth, type Auth } from "../auth/auth-provider";
import type { AccountUser } from "../auth/contract";
import { duplicateProject, validateRecord, type ProjectRecord } from "../project/projects";
import type { LocalProjectStorage } from "../store/storage";
import { runCloudCycle, type CloudCycleDependencies } from "./cloud-cycle";
import type { CloudLeave, CloudMoveBlock, CloudSync, CloudSyncStatus } from "./cloud-sync";
import {
  cloudSyncMachine,
  type CloudCycleWriteEvent,
  type CloudLeaveSave,
  type CloudProjectChange,
  type CloudSyncAccountEvent,
} from "./cloud-sync-machine";
import { isSyncableProjectId, measureCloudProject, type CloudService } from "./contract";
import { createCloudSession } from "./session-service";
import { SettingsDialog } from "./settings-dialog";
import { SignOutDialog } from "./sign-out-dialog";

const CloudSyncContext = createContext<CloudSync | null>(null);

/** A save started as the page closes must fit the browser's 64 KiB keepalive budget. */
const maxKeepaliveBytes = 60 * 1024;

/** How cloud sync writes into the workspace. */
type WorkspaceWrites = Pick<UseCloudSyncOptions, "putProject" | "removeProjects" | "flushProjects">;

/**
 * The workspace's projects and how to add or remove them, as of the last commit
 *
 * A cycle reads the workspace when it runs, not when the machine started, so the hook keeps this up to date after
 * each render and the actors read it.
 */
class LatestWorkspace {
  constructor(
    public projects: readonly ProjectRecord[],
    public writes: WorkspaceWrites,
  ) {}

  follow(projects: readonly ProjectRecord[], writes: WorkspaceWrites): void {
    this.projects = projects;
    this.writes = writes;
  }

  putProject: CloudCycleDependencies["putProject"] = (project) => this.writes.putProject(project);

  removeProjects: UseCloudSyncOptions["removeProjects"] = (ids) => this.writes.removeProjects(ids);

  flushProjects = () => this.writes.flushProjects();
}

/**
 * Save the projects edited since the last leave save or cycle as the page hides or closes
 *
 * Only a project this browser last matched with the cloud's current copy goes: one that changed elsewhere since, such
 * as a download held back while the user typed, waits for the next cycle to ask. A save as the page closes must
 * outlive the page, so nothing aborts it. A cycle that saves the same edit later finds it already in the cloud.
 */
function saveOnLeave(cloud: CloudService, projects: readonly ProjectRecord[], { changedIds, result }: CloudLeaveSave) {
  const index = new Map(result.status.projects.map((entry) => [entry.id, entry]));

  for (const id of changedIds) {
    const project = projects.find((item) => item.id === id);
    const projectState = result.projectStates.get(id);
    const synced = result.syncedCopies.get(id);
    const cloudCopy = index.get(id);

    if (
      project === undefined ||
      !isSyncableProjectId(id) ||
      (projectState !== "synced" && projectState !== "pending") ||
      synced === undefined ||
      cloudCopy?.revision !== synced.revision ||
      cloudCopy.digest !== synced.digest ||
      measureCloudProject(project) > maxKeepaliveBytes
    ) {
      continue;
    }

    void cloud
      .saveCloudProject({
        project,
        baseRevision: synced.revision,
        baseDigest: synced.digest,
        keepalive: true,
        signal: new AbortController().signal,
      })
      .catch(() => undefined);
  }
}

/**
 * Send the page's comings and goings to cloud sync
 *
 * The page coming back syncs again; the page hiding or closing saves the latest edits, never a cycle a closing page
 * would cut short. Returns the function that stops following.
 */
export function followPage(
  page: { window: EventTarget; document: EventTarget & Pick<Document, "visibilityState"> },
  send: (event: { type: "sync.refresh" } | { type: "page.leave" }) => void,
): () => void {
  const refresh = () => send({ type: "sync.refresh" });
  const leave = () => send({ type: "page.leave" });

  // A hidden page may be closed without a pagehide, as phones do, so hiding saves like leaving.
  const followVisibility = () => {
    if (page.document.visibilityState === "visible") {
      refresh();
    } else {
      leave();
    }
  };

  page.window.addEventListener("focus", refresh);
  page.window.addEventListener("online", refresh);
  page.window.addEventListener("pagehide", leave);
  page.document.addEventListener("visibilitychange", followVisibility);

  return () => {
    page.window.removeEventListener("focus", refresh);
    page.window.removeEventListener("online", refresh);
    page.window.removeEventListener("pagehide", leave);
    page.document.removeEventListener("visibilitychange", followVisibility);
  };
}

/** The workspace projects that differ from the previous list, at their new revision, then the ones that left it. */
export function getProjectChanges(
  before: readonly ProjectRecord[],
  after: readonly ProjectRecord[],
): CloudProjectChange[] {
  const known = new Map(before.map((project) => [project.id, project]));
  const kept = new Set(after.map((project) => project.id));
  const changed = after
    .filter((project) => known.get(project.id) !== project)
    .map((project) => ({ id: project.id, revision: project.revision }));
  const removed = before
    .filter((project) => !kept.has(project.id))
    .map((project) => ({ id: project.id, revision: null }));

  return [...changed, ...removed];
}

/** Runs one of the cycle's writes into the workspace, reported before and after so it never counts as an edit. */
async function reportWrites<Output>(
  projectIds: readonly string[],
  report: (event: CloudCycleWriteEvent) => void,
  write: () => Promise<Output>,
  getRevision: (output: Output | undefined, projectId: string) => number | null,
): Promise<Output> {
  for (const projectId of projectIds) {
    report({ type: "cycle.write.start", projectId });
  }

  let output: Output | undefined;

  try {
    output = await write();
    return output;
  } finally {
    for (const projectId of projectIds) {
      report({ type: "cycle.write.done", projectId, revision: getRevision(output, projectId) });
    }
  }
}

function provideCloudSyncMachine({
  cloud,
  storage,
  latest,
  reportSessionEnded,
  signOut,
}: {
  cloud: CloudService;
  storage: LocalProjectStorage;
  latest: LatestWorkspace;
  reportSessionEnded: () => void;
  signOut: (signal: AbortSignal) => Promise<void>;
}) {
  const session = createCloudSession({
    locks: navigator.locks,
    store: storage,
    flushProjects: latest.flushProjects,
    signOut,
  });

  return cloudSyncMachine.provide({
    actions: {
      reportSessionEnded,
      saveOnLeave: (_, save) => saveOnLeave(cloud, latest.projects, save),
    },
    actors: {
      leaveAccount: fromPromise(({ input, signal }) => session.signOut(input, signal)),
      expireSession: fromPromise(({ input, signal }) => session.expire(input.githubId, signal)),
      signOut: fromPromise(({ signal }) => session.run(signOut, signal)),
      runCycle: fromPromise(({ input, signal }) =>
        session.run(async (operationSignal) => {
          await latest.flushProjects();

          return runCloudCycle(
            {
              signal: operationSignal,
              fetchStatus: () => cloud.fetchCloudStatus({ signal: operationSignal }),
              fetchProject: (id) => cloud.fetchCloudProject({ id, signal: operationSignal }),
              save: (project, baseRevision, baseDigest) =>
                cloud.saveCloudProject({
                  project,
                  baseRevision,
                  ...(baseDigest === undefined ? {} : { baseDigest }),
                  signal: operationSignal,
                }),
              remove: (id, revision, digest) =>
                cloud.deleteCloudProject({ id, revision, digest, signal: operationSignal }),
              store: storage,
              readProjects: () => latest.projects,
              readUnopenableIds: () => storage.listUnopenableProjectIds(),
              putProject: (project) =>
                reportWrites(
                  [project.id],
                  input.reportWrite,
                  () => latest.putProject(project),
                  (stored) => stored?.revision ?? null,
                ),
              removeProjects: (ids) =>
                reportWrites(
                  ids,
                  input.reportWrite,
                  () => latest.removeProjects(ids),
                  () => null,
                ),
              readRecord: validateRecord,
              copyProject: (project, name) => duplicateProject(project, name),
              nowMs: () => Date.now(),
            },
            input,
          );
        }, signal),
      ),
    },
  });
}

/**
 * The account cloud sync runs for: the signed-in user once the local store loaded, or null
 *
 * Before the store loads, every synced project would look deleted here. Each session read gives a new user object, so
 * a read that finds the same account again restarts sync after the Worker refused the session.
 */
export function getCloudSyncUser(auth: Pick<Auth, "status" | "user">, loaded: boolean): AccountUser | null {
  return auth.status === "signedIn" && loaded ? auth.user : null;
}

function toCloudSyncAccountEvent(user: AccountUser | null): CloudSyncAccountEvent {
  return user === null ? { type: "account.clear" } : { type: "account.set", githubId: user.githubId };
}

/** What the workspace lends cloud sync. */
export interface UseCloudSyncOptions {
  storage: LocalProjectStorage;
  projects: readonly ProjectRecord[];
  /** False until the local store loaded, so a first load is not taken for edits. */
  loaded: boolean;
  /**
   * Adds a project from another machine, or replaces a local one with the cloud copy, without opening it. Settles once
   * saved, with the copy the workspace then holds.
   */
  putProject: CloudCycleDependencies["putProject"];
  /** Takes projects out of this browser, and settles once the store saved that; leaves a page open on one of them. */
  removeProjects: (ids: readonly string[]) => Promise<void>;
  /** Saves pending workspace edits before Cloud work reads or removes their stored copies. */
  flushProjects: () => Promise<void>;
}

/**
 * Run cloud sync for the workspace
 *
 * Starts when the tab signs in and stops when it signs out. Edits sync after a pause in editing, and the tab syncs
 * again when it comes back into view. When the page hides or closes, small changed projects go with a keepalive save;
 * the next cycle or visit reconciles anything else.
 */
export function useCloudSync({
  storage,
  projects,
  loaded,
  putProject,
  removeProjects,
  flushProjects,
}: UseCloudSyncOptions): CloudSync {
  const auth = useAuth();
  const { cloud, auth: authService } = useAppServices();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [latest] = useState(() => new LatestWorkspace(projects, { putProject, removeProjects, flushProjects }));
  useLayoutEffect(() => {
    latest.follow(projects, { putProject, removeProjects, flushProjects });
  });

  const [machine] = useState(() =>
    provideCloudSyncMachine({
      cloud,
      storage,
      latest,
      reportSessionEnded: auth.reportSessionEnded,
      // The session is read again, so the tab shows signed out once the Worker forgot it.
      signOut: async (signal) => {
        await authService.signOut({ signal });
        auth.reportSessionEnded();
      },
    }),
  );
  const actor = useActorRef(machine);
  const snapshot = useSelector(actor, (state) => state);

  const syncUser = getCloudSyncUser(auth, loaded);
  useEffect(() => {
    if (!loaded || (auth.status !== "signedIn" && auth.status !== "signedOut")) {
      return;
    }

    actor.send(toCloudSyncAccountEvent(syncUser));
  }, [actor, syncUser, loaded, auth.status]);

  const previous = useRef<readonly ProjectRecord[] | null>(null);
  useEffect(() => {
    if (!loaded) {
      return;
    }

    const before = previous.current;
    previous.current = projects;

    if (before === null || before === projects) {
      return;
    }

    actor.send({ type: "projects.change", changes: getProjectChanges(before, projects) });
  }, [actor, loaded, projects]);

  useEffect(() => followPage({ window, document }, (event) => actor.send(event)), [actor]);

  const { context } = snapshot;
  const result = context.result;
  const status: CloudSyncStatus = snapshot.matches("signedOut")
    ? "signedOut"
    : snapshot.matches("unavailable")
      ? "unavailable"
      : snapshot.matches("offline") || snapshot.matches("sessionFailed")
        ? "offline"
        : snapshot.matches("idle")
          ? "synced"
          : "syncing";
  const usage =
    result === null
      ? null
      : {
          bytes: result.status.usage.bytes,
          maxBytes: result.status.limits.maxTotalBytes,
          projects: result.status.usage.projects,
          maxProjects: result.status.limits.maxProjects,
          maxProjectBytes: result.status.limits.maxProjectBytes,
        };

  const isCloudProject = (projectId: string) => {
    if (context.moves.has(projectId)) {
      return true;
    }

    const projectState = result?.projectStates.get(projectId);

    return projectState !== undefined && projectState !== "local" && projectState !== "unsyncable";
  };

  const getMoveBlock = (projectId: string): CloudMoveBlock | null => {
    const project = projects.find((item) => item.id === projectId);

    if (usage === null || project === undefined || isCloudProject(projectId)) {
      return null;
    }

    const byteSize = result?.projectBytes.get(projectId) ?? measureCloudProject(project);

    if (byteSize > usage.maxProjectBytes) {
      return "too_large";
    }

    return usage.projects >= usage.maxProjects || usage.bytes + byteSize > usage.maxBytes ? "account_full" : null;
  };

  const cloudCount = projects.filter((project) => isCloudProject(project.id)).length;
  const leave: CloudLeave | null = snapshot.matches({ leaving: "asking" })
    ? { step: "asking", cloudCount, localCount: projects.length - cloudCount }
    : snapshot.matches({ leaving: "unsaved" })
      ? { step: "unsaved", unsavedCount: context.leaveUnsavedIds.length, error: context.error }
      : snapshot.matches({ leaving: "flushing" })
        ? { step: "saving" }
        : snapshot.matches("leaving")
          ? { step: "signing_out" }
          : null;

  return {
    status,
    usage,
    failures: result?.failures ?? [],
    copies: context.copies,
    dismissCopies: () => actor.send({ type: "copies.dismiss" }),
    heldUntilMs: status === "synced" ? result?.wakeAtMs : undefined,
    error: context.error,
    getProjectState: (projectId) => result?.projectStates.get(projectId),
    isCloudProject,
    getMoveBlock,
    moveToCloud: (projectId) => actor.send({ type: "project.move", projectId }),
    leave,
    signOut: () => actor.send({ type: "account.leave" }),
    confirmSignOut: () => actor.send({ type: "leave.confirm" }),
    retrySignOut: () => actor.send({ type: "leave.retry" }),
    cancelSignOut: () => actor.send({ type: "leave.cancel" }),
    settingsOpen,
    setSettingsOpen,
  };
}

/** Shares the workspace's cloud sync with the account menu, and shows its dialogs. */
export function CloudSyncProvider({ value, children }: { value: CloudSync; children: ReactNode }) {
  return (
    <CloudSyncContext.Provider value={value}>
      {children}
      <SettingsDialog cloudSync={value} />
      <SignOutDialog cloudSync={value} />
    </CloudSyncContext.Provider>
  );
}

/** The workspace's cloud sync, or null on pages outside the workspace, such as a shared link. */
export function useOptionalCloudSync(): CloudSync | null {
  return useContext(CloudSyncContext);
}
