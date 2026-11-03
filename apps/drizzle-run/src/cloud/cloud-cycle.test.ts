import { digestCloudProject } from "@drizzle-run/core/contracts";
import { projectManifest } from "@drizzle-run/test-fixtures";
import { describe, expect, it } from "vitest";

import { duplicateProject, type ProjectRecord } from "../project/projects";
import type { CloudSyncState } from "../store/storage";
import { getCopyName, runCloudCycle, type CloudCycleDependencies, type CloudCycleInput } from "./cloud-cycle";
import type { CloudProjectSummary, CloudSaveResult, CloudStatus } from "./contract";
import { CloudSyncError } from "./contract";

const a = "00000000-0000-4000-8000-00000000000a";
const b = "00000000-0000-4000-8000-00000000000b";
const githubId = 583231;
const limits = {
  maxProjects: 100,
  maxProjectBytes: 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
};

function makeProject(id: string, query = "export {};\n", updatedAt = "2026-10-17T10:00:00.000Z"): ProjectRecord {
  return {
    version: 1,
    id,
    name: `Project ${id.slice(-1)}`,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt,
    revision: 1,
    trust: "trusted",
    manifest: { ...projectManifest("sqlite"), files: { "schema.ts": "export {};\n", "query.ts": query } },
  };
}

/** A row that makes `project` Cloud, as last matched at `revision`; revision 0 before its first save. */
function makeCloudRow(project: ProjectRecord, revision = 0): CloudSyncState {
  return { projectId: project.id, revision, digest: revision === 0 ? "" : digestCloudProject(project) };
}

function makeSummary(project: ProjectRecord, revision: number): CloudProjectSummary {
  return {
    id: project.id,
    name: project.name,
    revision,
    digest: digestCloudProject(project),
    byteSize: 500,
    updatedAt: "2026-10-17T09:00:00.000Z",
  };
}

interface DependencyOptions {
  projects?: ProjectRecord[];
  cloud?: { summary: CloudProjectSummary; record: ProjectRecord }[];
  rows?: CloudSyncState[];
  status?: Partial<CloudStatus>;
  save?: (project: ProjectRecord, base: number) => Promise<CloudSaveResult>;
  fetchProject?: CloudCycleDependencies["fetchProject"];
  putProject?: CloudCycleDependencies["putProject"];
  readRecord?: (record: unknown) => ProjectRecord;
  unopenable?: string[];
}

/** A cloud and a local store in memory, with the calls each one received. */
function makeDependencies({
  projects = [],
  cloud = [],
  rows = [],
  status = {},
  save,
  fetchProject,
  putProject,
  readRecord = (record: unknown) => record as ProjectRecord,
  unopenable = [],
}: DependencyOptions = {}) {
  const local = new Map(projects.map((project) => [project.id, project]));
  const stored = new Map(rows.map((row) => [row.projectId, row]));
  const otherAccounts = new Map<number, Map<string, CloudSyncState>>();
  const getRows = (account: number) => {
    if (account === githubId) {
      return stored;
    }

    const rowsOfAccount = otherAccounts.get(account) ?? new Map<string, CloudSyncState>();
    otherAccounts.set(account, rowsOfAccount);

    return rowsOfAccount;
  };
  const saves: { id: string; baseRevision: number }[] = [];
  const removes: { id: string; revision: number; digest: string }[] = [];
  const discarded: string[] = [];
  const dependencies: CloudCycleDependencies = {
    signal: new AbortController().signal,
    fetchStatus: async () => ({
      githubId,
      limits,
      usage: { projects: cloud.length, bytes: cloud.length * 500 },
      projects: cloud.map((item) => item.summary),
      ...status,
    }),
    fetchProject:
      fetchProject ??
      (async (id) => {
        const item = cloud.find((entry) => entry.summary.id === id);

        if (item === undefined) {
          throw new Error(`Expected ${id} in the cloud`);
        }

        return { project: item.summary, record: item.record };
      }),
    save:
      save ??
      (async (project, baseRevision) => {
        saves.push({ id: project.id, baseRevision });
        return { kind: "saved", project: makeSummary(project, baseRevision + 1), unchanged: false };
      }),
    remove: async (id, revision, digest) => {
      removes.push({ id, revision, digest });
      return { kind: "deleted" };
    },
    store: {
      loadCloudSync: async (account) => [...getRows(account).values()],
      writeCloudSync: async (account, state) => {
        getRows(account).set(state.projectId, state);
      },
      deleteCloudSync: async (account, projectId) => {
        getRows(account).delete(projectId);
      },
    },
    readProjects: () => [...local.values()],
    readUnopenableIds: () => unopenable,
    putProject:
      putProject ??
      (async (project) => {
        local.set(project.id, project);
        return project;
      }),
    removeProjects: async (ids) => {
      for (const id of ids) {
        discarded.push(id);
        local.delete(id);
      }
    },
    readRecord,
    copyProject: (project, name) => duplicateProject(project, name),
    nowMs: () => Date.parse("2026-10-17T10:00:00.000Z"),
  };

  return { dependencies, local, stored, otherAccounts, saves, removes, discarded };
}

function makeInput(input: Partial<CloudCycleInput> = {}): CloudCycleInput {
  return { githubId, moves: new Set(), ...input };
}

describe("runCloudCycle", () => {
  it("should keep the cloud copy and sync row of a project this browser cannot open", async () => {
    const project = makeProject(a);
    const summary = makeSummary(project, 2);
    const row = { projectId: a, revision: summary.revision, digest: summary.digest };
    const { dependencies, stored, removes } = makeDependencies({
      cloud: [{ summary, record: project }],
      rows: [row],
      unopenable: [a],
    });

    await runCloudCycle(dependencies, makeInput());

    expect(removes).toEqual([]);
    expect(stored.get(a)).toEqual(row);
  });

  it("should save new Cloud projects, record them, and report them synced", async () => {
    const project = makeProject(a);
    const { dependencies, stored, saves } = makeDependencies({ projects: [project], rows: [makeCloudRow(project)] });

    const result = await runCloudCycle(dependencies, makeInput());

    expect(saves).toEqual([{ id: a, baseRevision: 0 }]);
    expect(stored.get(a)).toMatchObject({ revision: 1 });
    expect(result.projectStates.get(a)).toBe("synced");
    expect(result.status.usage.projects).toBe(1);
  });

  it("should leave a Local project out of the account", async () => {
    const { dependencies, stored, saves } = makeDependencies({ projects: [makeProject(a)] });

    const result = await runCloudCycle(dependencies, makeInput());

    expect(saves).toEqual([]);
    expect(stored.size).toBe(0);
    expect(result.projectStates.get(a)).toBe("local");
  });

  it("should report edits received during an upload as pending rather than synced", async () => {
    const project = makeProject(a);
    const edited = { ...makeProject(a, "// edited in another tab\n"), revision: 2 };
    const { dependencies, local, stored } = makeDependencies({
      projects: [project],
      rows: [makeCloudRow(project)],
      save: async (uploaded) => {
        local.set(a, edited);
        return { kind: "saved", project: makeSummary(uploaded, 1), unchanged: false };
      },
    });

    const result = await runCloudCycle(dependencies, makeInput());

    expect(local.get(a)).toEqual(edited);
    expect(stored.get(a)?.digest).toBe(digestCloudProject(project));
    expect(result.projectStates.get(a)).toBe("pending");
  });

  it("should refuse late upload results after cancellation without writing their sync row", async () => {
    const controller = new AbortController();
    const project = makeProject(a);
    const { dependencies, stored } = makeDependencies({
      projects: [project],
      rows: [makeCloudRow(project)],
      save: async (uploaded) => {
        controller.abort();
        return { kind: "saved", project: makeSummary(uploaded, 1), unchanged: false };
      },
    });

    await expect(runCloudCycle({ ...dependencies, signal: controller.signal }, makeInput())).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(stored.get(a)?.revision).toBe(0);
  });

  it("should refuse a late download after cancellation without putting it into the workspace", async () => {
    const controller = new AbortController();
    const project = makeProject(a);
    const summary = makeSummary(project, 1);
    const { dependencies, local, stored } = makeDependencies({
      cloud: [{ summary, record: project }],
      fetchProject: async () => {
        controller.abort();
        return { project: summary, record: project };
      },
    });

    await expect(runCloudCycle({ ...dependencies, signal: controller.signal }, makeInput())).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(local.size).toBe(0);
    expect(stored.size).toBe(0);
  });

  it("should bring in a Cloud project from another machine and remember it", async () => {
    const remote = makeProject(b);
    const { dependencies, local, stored } = makeDependencies({
      cloud: [{ summary: makeSummary(remote, 3), record: remote }],
    });

    const result = await runCloudCycle(dependencies, makeInput());

    expect(local.get(b)).toEqual(remote);
    expect(stored.get(b)).toMatchObject({ revision: 3 });
    expect(result.projectStates.get(b)).toBe("synced");
  });

  it("should keep edits typed while the cloud copy downloaded, and leave the row for the next cycle", async () => {
    const synced = makeProject(a);
    const remote = { ...synced, name: "From another machine", revision: synced.revision + 1 };
    const typed = { ...synced, name: "Typed meanwhile", revision: synced.revision + 1 };
    const row = { projectId: a, revision: 1, digest: digestCloudProject(synced) };
    const { dependencies, local, stored } = makeDependencies({
      projects: [synced],
      cloud: [{ summary: makeSummary(remote, 2), record: remote }],
      rows: [row],
      fetchProject: async () => {
        local.set(a, typed);
        return { project: makeSummary(remote, 2), record: remote };
      },
    });

    await runCloudCycle(dependencies, makeInput());

    expect(local.get(a)).toEqual(typed);
    expect(stored.get(a)).toEqual(row);
  });

  it("should keep a project deleted while its cloud copy downloaded deleted", async () => {
    const synced = makeProject(a);
    const remote = { ...synced, name: "From another machine", revision: synced.revision + 1 };
    const row = { projectId: a, revision: 1, digest: digestCloudProject(synced) };
    const { dependencies, local, stored } = makeDependencies({
      projects: [synced],
      cloud: [{ summary: makeSummary(remote, 2), record: remote }],
      rows: [row],
      fetchProject: async () => {
        local.delete(a);
        return { project: makeSummary(remote, 2), record: remote };
      },
    });

    await runCloudCycle(dependencies, makeInput());

    expect(local.has(a)).toBe(false);
    expect(stored.get(a)).toEqual(row);
  });

  it("should leave the row for a downloaded copy this browser failed to save, so the next cycle never pushes", async () => {
    const synced = makeProject(a);
    const remote = { ...synced, name: "From another machine", revision: synced.revision + 1 };
    const row = { projectId: a, revision: 1, digest: digestCloudProject(synced) };
    const { dependencies, local, stored, saves } = makeDependencies({
      projects: [synced],
      cloud: [{ summary: makeSummary(remote, 2), record: remote }],
      rows: [row],
      putProject: async () => {
        throw new Error("The project was not saved in this browser: QuotaExceededError");
      },
    });

    const first = await runCloudCycle(dependencies, makeInput());
    await runCloudCycle(dependencies, makeInput());

    expect(local.get(a)).toEqual(synced);
    expect(stored.get(a)).toEqual(row);
    expect(first.failures.map((failure) => failure.id)).toEqual([a]);
    expect(saves).toEqual([]);
  });

  it("should leave the row when another tab's copy replaced the download as it saved", async () => {
    const synced = makeProject(a);
    const remote = { ...synced, name: "From another machine", revision: synced.revision + 1 };
    const otherTab = { ...synced, name: "Saved first in another tab", revision: synced.revision + 2 };
    const row = { projectId: a, revision: 1, digest: digestCloudProject(synced) };
    const { dependencies, local, stored, saves } = makeDependencies({
      projects: [synced],
      cloud: [{ summary: makeSummary(remote, 2), record: remote }],
      rows: [row],
      putProject: async () => {
        local.set(a, otherTab);
        return otherTab;
      },
    });

    await runCloudCycle(dependencies, makeInput());
    const rowAfterDownload = stored.get(a);
    const next = await runCloudCycle(dependencies, makeInput());

    expect(rowAfterDownload).toEqual(row);
    expect(next.copies).toHaveLength(1);
    expect(saves.map((save) => save.baseRevision)).toEqual([0, 2]);
  });

  it("should remember a downloaded copy moved to the current Legacy release, and save the move next cycle", async () => {
    const remote = makeProject(b);
    const moved = makeProject(b, "// on the current Legacy release\n");
    const summary = makeSummary(remote, 3);
    const { dependencies, local, stored, saves } = makeDependencies({
      cloud: [{ summary, record: remote }],
      readRecord: () => moved,
    });

    const first = await runCloudCycle(dependencies, makeInput());
    const rowAfterDownload = stored.get(b);
    const next = await runCloudCycle(dependencies, makeInput());

    expect(local.get(b)).toEqual(moved);
    expect(first.projectStates.get(b)).toBe("pending");
    expect(rowAfterDownload).toEqual({ projectId: b, revision: 3, digest: summary.digest });
    expect(next.copies).toEqual([]);
    expect(saves).toEqual([{ id: b, baseRevision: 3 }]);
    expect(next.projectStates.get(b)).toBe("synced");
  });

  it("should stop new Cloud projects at the project limit without asking the Worker", async () => {
    const cloud = await Promise.all(
      Array.from({ length: 100 }, async (_, index) => {
        const record = makeProject(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
        return { summary: makeSummary(record, 1), record };
      }),
    );
    const { dependencies, saves } = makeDependencies({
      projects: [...cloud.map((item) => item.record), makeProject(a)],
      cloud,
      rows: [...cloud.map((item) => makeCloudRow(item.record, 1)), makeCloudRow(makeProject(a))],
    });

    const result = await runCloudCycle(dependencies, makeInput());

    expect(saves).toEqual([]);
    expect(result.projectStates.get(a)).toBe("limit");
  });

  it("should hold the remaining saves once the account is rate limited, and wake when it may save again", async () => {
    const attempts: string[] = [];
    const { dependencies } = makeDependencies({
      projects: [makeProject(a), makeProject(b)],
      rows: [makeCloudRow(makeProject(a)), makeCloudRow(makeProject(b))],
      save: async (project) => {
        attempts.push(project.id);
        return { kind: "rate_limited", retryAfterMs: 60_000 };
      },
    });

    const result = await runCloudCycle(dependencies, makeInput());

    expect(attempts).toHaveLength(1);
    expect(result.failures).toEqual([]);
    expect(result.wakeAtMs).toBe(Date.parse("2026-10-17T10:01:00.000Z"));
    expect([result.projectStates.get(a), result.projectStates.get(b)]).toEqual(["pending", "pending"]);
  });

  it("should move a Local project to Cloud and save it", async () => {
    const project = makeProject(a);
    const { dependencies, stored, saves } = makeDependencies({ projects: [project] });

    const result = await runCloudCycle(dependencies, makeInput({ moves: new Set([a]) }));

    expect(saves).toEqual([{ id: a, baseRevision: 0 }]);
    expect(stored.get(a)).toMatchObject({ revision: 1 });
    expect(result.projectStates.get(a)).toBe("synced");
    expect(result.moved).toEqual(new Set([a]));
    expect(result.moved).toEqual(new Set([a]));
  });

  it("should record a refused save as saved when the cloud copy already holds the same edit", async () => {
    const before = makeProject(a);
    const edited = makeProject(a, "// edited\n");
    const saved = makeSummary(edited, 3);
    const { dependencies, stored } = makeDependencies({
      projects: [edited],
      cloud: [{ summary: makeSummary(before, 2), record: before }],
      rows: [{ projectId: a, revision: 2, digest: digestCloudProject(before) }],
      save: async () => ({ kind: "conflict", current: saved }),
    });

    const result = await runCloudCycle(dependencies, makeInput());

    expect(result.copies).toEqual([]);
    expect(result.projectStates.get(a)).toBe("synced");
    expect(stored.get(a)).toEqual({ projectId: a, revision: 3, digest: saved.digest });
  });

  it("should keep the other machine's version as a Cloud copy, then save this browser's over the original", async () => {
    const mine = makeProject(a, "// mine\n");
    const theirs = makeProject(a, "// theirs\n");
    const summary = makeSummary(theirs, 2);
    const { dependencies, local, stored, saves } = makeDependencies({
      projects: [mine],
      cloud: [{ summary, record: theirs }],
      rows: [{ projectId: a, revision: 1, digest: "0".repeat(64) }],
    });

    const result = await runCloudCycle(dependencies, makeInput());
    const copy = [...local.values()].find((project) => project.id !== a);

    expect(local.get(a)).toEqual(mine);
    expect(copy?.name).toBe(`${theirs.name} (copy)`);
    expect(copy?.manifest.files).toEqual(theirs.manifest.files);
    expect(result.copies).toEqual([{ projectId: a, copyId: copy?.id, name: mine.name, copyName: copy?.name }]);
    expect(saves).toEqual([
      { id: copy?.id, baseRevision: 0 },
      { id: a, baseRevision: 2 },
    ]);
    expect(stored.get(copy?.id ?? "")).toMatchObject({ revision: 1 });
    expect(result.projectStates.get(a)).toBe("synced");
  });

  it("should add one copy only when this browser's save fails after the copy", async () => {
    const mine = makeProject(a, "// mine\n");
    const theirs = makeProject(a, "// theirs\n");
    const summary = makeSummary(theirs, 2);
    const cloud = [{ summary, record: theirs }];
    const failing = makeDependencies({
      projects: [mine],
      cloud,
      rows: [{ projectId: a, revision: 1, digest: "0".repeat(64) }],
      save: async (project) => {
        if (project.id === a) {
          throw new CloudSyncError("invalid_project", "The project record is invalid.");
        }

        return { kind: "saved", project: makeSummary(project, 1), unchanged: false };
      },
    });

    const first = await runCloudCycle(failing.dependencies, makeInput());
    const copy = [...failing.local.values()].find((project) => project.id !== a);

    if (copy === undefined) {
      throw new Error("Expected the other machine's version as a copy, but got none.");
    }

    const retried = makeDependencies({
      projects: [...failing.local.values()],
      cloud: [...cloud, { summary: makeSummary(copy, 1), record: copy }],
      rows: [...failing.stored.values()],
    });
    const second = await runCloudCycle(retried.dependencies, makeInput());

    expect(first.copies).toHaveLength(1);
    expect(first.projectStates.get(a)).toBe("failed");
    expect(failing.stored.get(a)).toEqual({ projectId: a, revision: 2, digest: summary.digest });
    expect(second.copies).toEqual([]);
    expect(retried.local.size).toBe(2);
    expect(retried.saves).toEqual([{ id: a, baseRevision: 2 }]);
  });

  it("should wake soon when the cloud copy moved after the plan, so the next cycle plans against it", async () => {
    const before = makeProject(a);
    const edited = makeProject(a, "// edited\n");
    const elsewhere = makeSummary(makeProject(a, "// elsewhere\n"), 3);
    const { dependencies, stored } = makeDependencies({
      projects: [edited],
      cloud: [{ summary: makeSummary(before, 2), record: before }],
      rows: [makeCloudRow(before, 2)],
      save: async () => ({ kind: "conflict", current: elsewhere }),
    });

    const result = await runCloudCycle(dependencies, makeInput());

    expect(result.wakeAtMs).toBe(Date.parse("2026-10-17T10:00:00.000Z"));
    expect(result.projectStates.get(a)).toBe("pending");
    expect(stored.get(a)).toEqual(makeCloudRow(before, 2));
  });

  it("should take a project removed from the account elsewhere out of this browser, rows first", async () => {
    const removed = makeProject(a);
    const edited = makeProject(b, "// edited after its last save\n");
    const order: string[] = [];
    const { dependencies, local, stored, discarded } = makeDependencies({
      projects: [removed, edited],
      rows: [makeCloudRow(removed, 3), { ...makeCloudRow(makeProject(b), 2) }],
    });
    const store = dependencies.store;
    dependencies.store = {
      ...store,
      deleteCloudSync: async (account, projectId) => {
        order.push(`row ${projectId}`);
        await store.deleteCloudSync(account, projectId);
      },
    };
    const removeProjects = dependencies.removeProjects;
    dependencies.removeProjects = async (ids) => {
      order.push(`project ${ids.join()}`);
      await removeProjects(ids);
    };

    const result = await runCloudCycle(dependencies, makeInput());

    expect(discarded).toEqual([a]);
    expect(order).toEqual([`row ${b}`, `row ${a}`, `project ${a}`]);
    expect(local.has(b)).toBe(true);
    expect(stored.size).toBe(0);
    expect(result.projectStates.get(b)).toBe("local");
  });

  it("should keep edits received while forgetting a remotely deleted project's row as Local", async () => {
    const project = makeProject(a);
    const edited = { ...makeProject(a, "// edited while forgetting the row\n"), revision: 2 };
    const { dependencies, local, stored, discarded } = makeDependencies({
      projects: [project],
      rows: [makeCloudRow(project, 1)],
    });
    const store = dependencies.store;
    dependencies.store = {
      ...store,
      deleteCloudSync: async (account, projectId) => {
        await store.deleteCloudSync(account, projectId);
        local.set(a, edited);
      },
    };

    const result = await runCloudCycle(dependencies, makeInput());

    expect(local.get(a)).toEqual(edited);
    expect(stored.has(a)).toBe(false);
    expect(discarded).toEqual([]);
    expect(result.projectStates.get(a)).toBe("local");
  });

  it("should keep a project whose cloud copy cannot be read as a failure, and sync the others", async () => {
    const remote = makeProject(b);
    const { dependencies, local, stored, saves } = makeDependencies({
      projects: [makeProject(a)],
      rows: [makeCloudRow(makeProject(a))],
      cloud: [{ summary: makeSummary(remote, 2), record: remote }],
      fetchProject: async () => {
        throw new CloudSyncError("cloud_project_corrupt", "The cloud copy of this project cannot be read.");
      },
    });

    const result = await runCloudCycle(dependencies, makeInput());

    expect(result.failures).toEqual([
      { id: b, name: remote.name, message: "The cloud copy of this project cannot be read." },
    ]);
    expect(local.has(b)).toBe(false);
    expect(stored.has(b)).toBe(false);
    expect(saves).toEqual([{ id: a, baseRevision: 0 }]);
    expect(result.projectStates.get(a)).toBe("synced");
  });

  it("should leave a downloaded record this version rejects in the cloud, as a failure", async () => {
    const remote = makeProject(b);
    const { dependencies, local, stored } = makeDependencies({
      cloud: [{ summary: makeSummary(remote, 2), record: remote }],
      readRecord: () => {
        throw new Error("Project record version 9 is newer than this app.");
      },
    });

    const result = await runCloudCycle(dependencies, makeInput());

    expect(result.failures).toEqual([
      { id: b, name: remote.name, message: "Project record version 9 is newer than this app." },
    ]);
    expect(local.has(b)).toBe(false);
    expect(stored.has(b)).toBe(false);
  });

  it("should mark a project the Worker refuses as failed, and save the others", async () => {
    const refused = makeProject(a);
    const accepted = makeProject(b);
    const saves: string[] = [];
    const { dependencies } = makeDependencies({
      projects: [refused, accepted],
      rows: [makeCloudRow(refused), makeCloudRow(accepted)],
      save: async (project, baseRevision) => {
        if (project.id === a) {
          throw new CloudSyncError("invalid_project", "The project record is invalid.");
        }

        saves.push(project.id);
        return { kind: "saved", project: makeSummary(project, baseRevision + 1), unchanged: false };
      },
    });

    const result = await runCloudCycle(dependencies, makeInput());

    expect(saves).toEqual([b]);
    expect(result.projectStates.get(a)).toBe("failed");
    expect(result.projectStates.get(b)).toBe("synced");
    expect(result.failures).toEqual([{ id: a, name: refused.name, message: "The project record is invalid." }]);
  });

  it("should stop the cycle on a network failure or unreachable storage", async () => {
    const network = makeDependencies({
      projects: [makeProject(a)],
      rows: [makeCloudRow(makeProject(a))],
      save: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const storage = makeDependencies({
      projects: [makeProject(a)],
      rows: [makeCloudRow(makeProject(a))],
      save: async () => {
        throw new CloudSyncError("cloud_storage_unavailable", "The project could not sync right now. Try again.");
      },
    });

    await expect(runCloudCycle(network.dependencies, makeInput())).rejects.toThrow(TypeError);
    await expect(runCloudCycle(storage.dependencies, makeInput())).rejects.toMatchObject({
      code: "cloud_storage_unavailable",
    });
  });

  it("should refuse to plan this browser's rows against another account's cloud", async () => {
    const project = makeProject(a);
    const { dependencies, stored, otherAccounts, saves, removes } = makeDependencies({
      projects: [project],
      rows: [{ projectId: a, revision: 1, digest: digestCloudProject(project) }],
    });

    const cycle = runCloudCycle(dependencies, makeInput({ githubId: 42 }));

    await expect(cycle).rejects.toMatchObject({ code: "account_changed" });
    expect(saves).toEqual([]);
    expect(removes).toEqual([]);
    expect(stored.get(a)).toMatchObject({ revision: 1 });
    expect(otherAccounts.size).toBe(0);
  });

  it("should keep each account's rows apart, so switching accounts never removes the first one's cloud copy", async () => {
    const project = makeProject(a);
    const browserRows = new Map<number, Map<string, CloudSyncState>>();
    const store: CloudCycleDependencies["store"] = {
      loadCloudSync: async (account) => [...(browserRows.get(account)?.values() ?? [])],
      writeCloudSync: async (account, state) => {
        browserRows.set(account, new Map(browserRows.get(account)).set(state.projectId, state));
      },
      deleteCloudSync: async (account, projectId) => {
        browserRows.get(account)?.delete(projectId);
      },
    };
    const cloudOfA: { summary: CloudProjectSummary; record: ProjectRecord }[] = [];
    const accountA = makeDependencies({ projects: [project], status: { githubId: 1 } });
    await store.writeCloudSync(1, makeCloudRow(project));
    const accountB = makeDependencies({ projects: [project], status: { githubId: 2 } });

    await runCloudCycle({ ...accountA.dependencies, store }, makeInput({ githubId: 1 }));
    cloudOfA.push({ summary: makeSummary(project, 1), record: project });

    await runCloudCycle({ ...accountB.dependencies, store }, makeInput({ githubId: 2 }));

    const backToA = makeDependencies({ projects: [project], cloud: cloudOfA, status: { githubId: 1 } });
    const result = await runCloudCycle({ ...backToA.dependencies, store }, makeInput({ githubId: 1 }));

    expect(accountA.saves).toEqual([{ id: a, baseRevision: 0 }]);
    expect(accountB.saves).toEqual([]);
    expect(backToA.removes).toEqual([]);
    expect(backToA.saves).toEqual([]);
    expect(result.projectStates.get(a)).toBe("synced");
    expect(browserRows.get(1)?.get(a)).toMatchObject({ revision: 1 });
    expect(browserRows.get(2)?.has(a) ?? false).toBe(false);
  });
});

describe("getCopyName", () => {
  it("should name the first copy (copy), then number the next ones", () => {
    expect(getCopyName("Users", new Set())).toBe("Users (copy)");
    expect(getCopyName("Users", new Set(["Users (copy)"]))).toBe("Users (copy 2)");
    expect(getCopyName("Users", new Set(["Users (copy)", "Users (copy 2)"]))).toBe("Users (copy 3)");
  });

  it("should keep the copy's name under 160 characters", () => {
    expect(getCopyName("x".repeat(160), new Set()).length).toBeLessThanOrEqual(160);
  });
});
