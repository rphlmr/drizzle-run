import { digestCloudProject } from "@drizzle-run/core/contracts";

import { getErrorText } from "../lib/error-text";
import type { ProjectRecord } from "../project/projects";
import type { CloudSyncState, CloudSyncStore } from "../store/storage";
import { planCloudSync, type LocalCloudProject } from "./cloud-plan";
import type { CloudProjectSummary, CloudSaveResult, CloudStatus } from "./contract";
import { CloudSyncError, isSyncableProjectId, measureCloudProject } from "./contract";

/** How one local project stands with the account, as the projects table and the status bar show it. */
export type ProjectSyncState = "synced" | "pending" | "local" | "too_large" | "limit" | "failed" | "unsyncable";

/** A project this cycle could not download, save or remove, and why. The other projects went on. */
export interface CloudProjectFailure {
  id: string;
  name: string;
  message: string;
}

/** The other machine's version of a project both sides changed, added here under `copyName`. */
export interface CloudConflictCopy {
  projectId: string;
  copyId: string;
  name: string;
  copyName: string;
}

/** What a sync cycle needs: the cloud API, this browser's sync rows, and the workspace's projects. */
export interface CloudCycleDependencies {
  signal: AbortSignal;
  fetchStatus: () => Promise<CloudStatus>;
  fetchProject(id: string): Promise<{ project: CloudProjectSummary; record: unknown }>;
  save: (project: ProjectRecord, baseRevision: number, baseDigest: string | undefined) => Promise<CloudSaveResult>;
  remove(
    id: string,
    revision: number,
    digest: string,
  ): Promise<{ kind: "deleted" } | { kind: "conflict"; current: CloudProjectSummary | null }>;
  store: CloudSyncStore;
  /** The workspace's projects right now; read again after each download. */
  readProjects: () => readonly ProjectRecord[];
  /** Ids of projects this browser keeps but cannot open, such as one on a removed pair. */
  readUnopenableIds: () => readonly string[];
  /**
   * Adds a project from another machine, or replaces a local one with the cloud copy, and settles once this browser
   * saved it. Resolves with the copy the workspace holds then, which another tab's save may have replaced, or null
   * when it holds none. Rejects when the save failed.
   */
  putProject: (project: ProjectRecord) => Promise<ProjectRecord | null>;
  /** Takes projects out of this browser, and settles once the store saved that. */
  removeProjects: (ids: readonly string[]) => Promise<void>;
  /** Validates a downloaded record as a project. Throws when it is not one. */
  readRecord: (record: unknown) => ProjectRecord;
  /** A new project with the content of `project`, under a new id and `name`. */
  copyProject: (project: ProjectRecord, name: string) => ProjectRecord;
  nowMs: () => number;
}

/** What a cycle starts from. */
export interface CloudCycleInput {
  /** GitHub's numeric id of the account this tab signed in as; this browser's rows for it are the ones planned. */
  githubId: number;
  /** Projects moved to Cloud since the last cycle; their rows are written before planning. */
  moves: ReadonlySet<string>;
}

/** What a cycle leaves for the UI and the next cycle. */
export interface CloudCycleResult {
  status: CloudStatus;
  projectStates: ReadonlyMap<string, ProjectSyncState>;
  /** Projects this cycle could not sync, including ones only the cloud has; the next cycle tries them again. */
  failures: readonly CloudProjectFailure[];
  /** Local byte size of every project, Cloud or Local. */
  projectBytes: ReadonlyMap<string, number>;
  /** The other machine's versions this cycle added as new projects. */
  copies: readonly CloudConflictCopy[];
  /** The moves this cycle wrote, to drop from the pending ones. */
  moved: ReadonlySet<string>;
  /** When the next cycle should run by itself, such as after a rate limit; undefined when none waits. */
  wakeAtMs: number | undefined;
  /** The cloud copy each Cloud project here was last matched with, so a save as the page closes builds on it. */
  syncedCopies: ReadonlyMap<string, { revision: number; digest: string }>;
}

/**
 * Codes that concern the whole cycle rather than one project: the network or storage, the session, the account, or
 * the deployment. They stop the cycle; any other refusal stays with the project it came from.
 */
const cycleErrorCodes: ReadonlySet<string> = new Set([
  "cloud_storage_unavailable",
  "sign_in_required",
  "account_changed",
  "cloud_sync_unavailable",
  "same_origin_required",
  "cloud_sync_timeout",
]);

/**
 * Whether a failed request concerns only its project
 *
 * The Worker's refusals carry a code, such as a missing or corrupt cloud copy or an invalid record. A request that
 * never got an answer throws something else, a `TypeError` from fetch, and stops the cycle as offline.
 */
function isProjectFailure(error: unknown): error is CloudSyncError {
  return error instanceof CloudSyncError && !cycleErrorCodes.has(error.code);
}

/** Longest project name kept before the " (copy N)" suffix, so the copy's name stays under 160 characters. */
const maxCopyBaseLength = 145;

/**
 * The name of the other machine's version of a project: "<name> (copy)", then "<name> (copy 2)" and on, whichever no
 * project here has yet
 */
export function getCopyName(name: string, takenNames: ReadonlySet<string>): string {
  const base = name.slice(0, maxCopyBaseLength);

  for (let index = 1; ; index++) {
    const candidate = index === 1 ? `${base} (copy)` : `${base} (copy ${index})`;

    if (!takenNames.has(candidate)) {
      return candidate;
    }
  }
}

function describeLocal(projects: readonly ProjectRecord[]): LocalCloudProject[] {
  return projects.map((project) => ({
    project,
    digest: digestCloudProject(project),
    byteSize: measureCloudProject(project),
  }));
}

/**
 * Run one sync cycle
 *
 * Reads the account's index, plans against this browser's projects and rows for that account, then downloads, removes
 * and saves one step at a time. Limits stop only what they concern: a full account keeps saving the projects it
 * already holds. A project the Worker refuses, or whose cloud copy cannot be read, becomes a failure while the others
 * go on. Network failures throw, and so does a cloud that belongs to another account than `input.githubId`
 * (`account_changed`).
 */
export async function runCloudCycle(
  dependencies: CloudCycleDependencies,
  input: CloudCycleInput,
): Promise<CloudCycleResult> {
  const { signal } = dependencies;
  signal.throwIfAborted();
  const status = await dependencies.fetchStatus();
  signal.throwIfAborted();

  // Another tab signed in as someone else: this tab's rows must never meet that account's cloud
  if (status.githubId !== input.githubId) {
    throw new CloudSyncError(
      "account_changed",
      "This tab was signed in to another GitHub account. Reload the page to see that account's projects.",
    );
  }

  const { githubId } = input;
  const index = new Map(status.projects.map((entry) => [entry.id, entry]));
  const rows = new Map((await dependencies.store.loadCloudSync(githubId)).map((row) => [row.projectId, row]));
  signal.throwIfAborted();

  // Apply the moves first: a project moved to Cloud gets its row, so the plan saves it.
  for (const projectId of input.moves) {
    if (rows.has(projectId)) {
      continue;
    }

    const state = { projectId, revision: 0, digest: "" };
    rows.set(projectId, state);
    await dependencies.store.writeCloudSync(githubId, state);
    signal.throwIfAborted();
  }

  const syncable = dependencies.readProjects().filter((project) => isSyncableProjectId(project.id));
  const local = describeLocal(syncable);
  const plan = planCloudSync({
    local,
    cloud: status.projects,
    rows: [...rows.values()],
    unopenable: new Set(dependencies.readUnopenableIds()),
    maxProjectBytes: status.limits.maxProjectBytes,
  });

  const tooLarge = new Set<string>();
  const overLimit = new Set<string>();
  const failures = new Map<string, CloudProjectFailure>();
  const copies: CloudConflictCopy[] = [];
  let wakeAtMs: number | undefined;
  let pushesHeld = false;
  const localById = new Map(local.map((item) => [item.project.id, item]));

  const wakeAt = (atMs: number) => {
    wakeAtMs = Math.min(wakeAtMs ?? atMs, atMs);
  };

  const writeRow = async (state: CloudSyncState) => {
    signal.throwIfAborted();
    rows.set(state.projectId, state);
    await dependencies.store.writeCloudSync(githubId, state);
    signal.throwIfAborted();
  };

  const forgetRow = async (id: string) => {
    signal.throwIfAborted();
    rows.delete(id);
    await dependencies.store.deleteCloudSync(githubId, id);
    signal.throwIfAborted();
  };

  const recordFailure = (id: string, error: unknown) => {
    const name = localById.get(id)?.project.name ?? index.get(id)?.name ?? id;
    failures.set(id, { id, name, message: getErrorText(error) });
  };

  const hasChangedSincePlan = (id: string) => {
    const current = dependencies.readProjects().find((project) => project.id === id);
    const planned = localById.get(id);

    if (current === undefined) {
      return planned !== undefined;
    }

    if (current === planned?.project) {
      return false;
    }

    return planned === undefined || digestCloudProject(current) !== planned.digest;
  };

  const recordSaved = async (entry: CloudProjectSummary) => {
    index.set(entry.id, entry);
    await writeRow({ projectId: entry.id, revision: entry.revision, digest: entry.digest });
  };

  const fetchProject = async (id: string) => {
    try {
      const downloaded = await dependencies.fetchProject(id);
      signal.throwIfAborted();

      return downloaded;
    } catch (cause) {
      if (!isProjectFailure(cause)) {
        throw cause;
      }

      recordFailure(id, cause);
      return null;
    }
  };

  // Save one project, unless a limit says no room; a refusal stays with the project, and a rate limit holds every
  // save after it until the next cycle.
  const push = async (id: string, baseRevision: number, baseDigest: string | undefined) => {
    const item = localById.get(id);

    if (item === undefined || pushesHeld) {
      return;
    }

    const usedBytes = [...index.values()].reduce((total, entry) => total + entry.byteSize, 0);
    const replacedBytes = index.get(id)?.byteSize ?? 0;

    if (
      (baseRevision === 0 && index.size >= status.limits.maxProjects) ||
      usedBytes - replacedBytes + item.byteSize > status.limits.maxTotalBytes
    ) {
      overLimit.add(id);
      return;
    }

    let result: CloudSaveResult;

    try {
      signal.throwIfAborted();
      result = await dependencies.save(item.project, baseRevision, baseDigest);
      signal.throwIfAborted();
    } catch (cause) {
      if (!isProjectFailure(cause)) {
        throw cause;
      }

      recordFailure(id, cause);
      return;
    }

    if (result.kind === "saved") {
      await recordSaved(result.project);
    } else if (result.kind === "conflict" && result.current?.digest === item.digest) {
      // The cloud already holds this edit, such as one the page's leave save sent.
      await recordSaved(result.current);
    } else if (result.kind === "conflict") {
      // The cloud copy moved after the plan: the next cycle plans against it.
      wakeAt(dependencies.nowMs());
    } else if (result.kind === "rate_limited") {
      wakeAt(dependencies.nowMs() + result.retryAfterMs);
      pushesHeld = true;
    } else if (result.kind === "too_large") {
      tooLarge.add(id);
    } else {
      overLimit.add(id);
    }
  };

  for (const step of plan.steps) {
    signal.throwIfAborted();

    switch (step.kind) {
      case "record":
        await writeRow(step.state);
        break;
      case "forget":
        await forgetRow(step.id);
        break;
      case "download": {
        const downloaded = await fetchProject(step.id);

        if (downloaded === null) {
          break;
        }

        const { project: entry, record } = downloaded;
        let project: ProjectRecord;

        // A record this version cannot read stays in the cloud, untouched, for a newer version or another machine.
        try {
          project = dependencies.readRecord(record);
        } catch (cause) {
          recordFailure(step.id, cause);
          break;
        }

        // Edits typed, or a delete, while the copy downloaded are newer than the plan: they stay, and the next cycle
        // plans with them.
        if (hasChangedSincePlan(step.id)) {
          break;
        }

        let stored: ProjectRecord | null;

        try {
          stored = await dependencies.putProject(project);
          signal.throwIfAborted();
        } catch (cause) {
          signal.throwIfAborted();
          recordFailure(step.id, cause);
          break;
        }

        // The row says this browser holds the cloud copy, so it waits until the store does. Another tab may have saved
        // the project first: the row then stays, and the next cycle plans with the store's copy. Reading the copy may
        // have moved it to the current Legacy release: the store then holds that move, and the next cycle saves it.
        const storedDigest = stored === null ? null : digestCloudProject(stored);
        const readDigest = digestCloudProject(project);

        if (storedDigest !== entry.digest && storedDigest !== readDigest) {
          break;
        }

        localById.set(project.id, { project, digest: readDigest, byteSize: measureCloudProject(project) });
        await recordSaved(entry);
        break;
      }
      case "discard": {
        if (hasChangedSincePlan(step.id)) {
          break;
        }

        // The row goes first: a row left for a project gone here would remove its cloud copy if it came back.
        try {
          await forgetRow(step.id);

          if (!hasChangedSincePlan(step.id)) {
            await dependencies.removeProjects([step.id]);
          }
        } catch (cause) {
          signal.throwIfAborted();
          recordFailure(step.id, cause);
        }

        break;
      }
      case "copy": {
        const downloaded = await fetchProject(step.id);
        const item = localById.get(step.id);

        if (downloaded === null || item === undefined) {
          break;
        }

        const { project: entry, record } = downloaded;

        // Another machine saved this same content meanwhile: nothing to keep apart.
        if (entry.digest === item.digest) {
          await recordSaved(entry);
          break;
        }

        let copy: ProjectRecord;

        try {
          const theirs = dependencies.readRecord(record);
          const takenNames = new Set(dependencies.readProjects().map((project) => project.name));
          copy = dependencies.copyProject(theirs, getCopyName(theirs.name, takenNames));
          await dependencies.putProject(copy);
          signal.throwIfAborted();
        } catch (cause) {
          signal.throwIfAborted();
          recordFailure(step.id, cause);
          break;
        }

        // Once the other version lives here as its own project, this one saves over the cloud's as a plain edit: a
        // save that fails now goes next cycle and never copies twice.
        localById.set(copy.id, {
          project: copy,
          digest: digestCloudProject(copy),
          byteSize: measureCloudProject(copy),
        });
        await writeRow({ projectId: copy.id, revision: 0, digest: "" });
        await writeRow({ projectId: step.id, revision: entry.revision, digest: entry.digest });
        copies.push({ projectId: step.id, copyId: copy.id, name: item.project.name, copyName: copy.name });

        await push(copy.id, 0, undefined);
        await push(step.id, entry.revision, entry.digest);
        break;
      }
      case "remove": {
        let result: Awaited<ReturnType<CloudCycleDependencies["remove"]>>;

        try {
          result = await dependencies.remove(step.id, step.revision, step.digest);
          signal.throwIfAborted();
        } catch (cause) {
          if (!isProjectFailure(cause)) {
            throw cause;
          }

          recordFailure(step.id, cause);
          break;
        }

        // A copy saved again elsewhere since stays in the account; this browser stops following it either way.
        if (result.kind === "deleted") {
          index.delete(step.id);
        }

        await forgetRow(step.id);
        break;
      }
      case "too_large":
        tooLarge.add(step.id);
        break;
      case "push":
        await push(step.id, step.baseRevision, step.baseDigest);
        break;
    }
  }

  const projectStates = new Map<string, ProjectSyncState>();
  signal.throwIfAborted();
  const projectBytes = new Map<string, number>();

  for (const project of dependencies.readProjects()) {
    const item = localById.get(project.id);
    const row = rows.get(project.id);
    const entry = index.get(project.id);
    const unchanged = project === item?.project;
    const digest = unchanged ? item.digest : digestCloudProject(project);
    projectBytes.set(project.id, unchanged ? item.byteSize : measureCloudProject(project));

    if (!isSyncableProjectId(project.id)) {
      projectStates.set(project.id, "unsyncable");
    } else if (row === undefined) {
      projectStates.set(project.id, "local");
    } else if (failures.has(project.id)) {
      projectStates.set(project.id, "failed");
    } else if (tooLarge.has(project.id)) {
      projectStates.set(project.id, "too_large");
    } else if (overLimit.has(project.id)) {
      projectStates.set(project.id, "limit");
    } else if (entry !== undefined && entry.digest === digest) {
      projectStates.set(project.id, "synced");
    } else {
      projectStates.set(project.id, "pending");
    }
  }

  const projects = [...index.values()].toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return {
    status: {
      ...status,
      projects,
      usage: {
        ...status.usage,
        projects: projects.length,
        bytes: projects.reduce((total, entry) => total + entry.byteSize, 0),
      },
    },
    projectStates,
    failures: [...failures.values()],
    projectBytes,
    copies,
    moved: new Set(input.moves),
    wakeAtMs,
    syncedCopies: new Map(
      [...rows.values()]
        .filter((row) => row.revision > 0)
        .map((row) => [row.projectId, { revision: row.revision, digest: row.digest }]),
    ),
  };
}
