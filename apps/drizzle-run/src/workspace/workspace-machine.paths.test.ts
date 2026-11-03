import {
  type ActorOutcome,
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  type ModelEvent,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, type SnapshotFrom } from "xstate";

import { createProject, type ProjectRecord } from "../project/projects";
import { workspaceMachine } from "./workspace-machine";

const SAVE_ID = "0.workspace.saving";
const DEBOUNCE_EVENT = { type: "xstate.after.500.workspace.debouncing" } as const;

const project = createProject("Bank transfers", { dialect: "sqlite" });
const projectSavedElsewhere: ProjectRecord = { ...project, name: "Renamed elsewhere", revision: 2 };
const storage = { load: vi.fn(), save: vi.fn() };

const loadOutcome: ActorOutcome<ProjectRecord[]> = { outputs: [[]], error: new Error("Local storage is unavailable") };
const saveOutcome: ActorOutcome<number> = {
  outputs: Array.from({ length: 64 }, (_, revision) => revision),
  error: new Error("The quota is exceeded"),
};

const changeToEmptyList = { type: "projects.change", projects: [] } as const;
const addProject = { type: "projects.add", projects: [project] } as const;
const mergeRemoval = {
  type: "projects.merge",
  projects: [],
  deletedIds: [project.id],
  knownRevisions: { [project.id]: project.revision },
} as const;
const mergeReplacingEdits = {
  type: "projects.merge",
  projects: [projectSavedElsewhere],
  deletedIds: [],
  knownRevisions: { [project.id]: 1 },
} as const;
const eventLabels = new Map<object, string>([
  [changeToEmptyList, "projects.change to an empty list"],
  [addProject, "projects.add"],
  [mergeRemoval, "projects.merge removing the original"],
  [mergeReplacingEdits, "projects.merge replacing the edits here"],
]);

type WorkspaceSnapshot = SnapshotFrom<typeof workspaceMachine>;

function resolveSavedRevision(snapshot: WorkspaceSnapshot): number | undefined {
  const input: unknown = snapshot.children[SAVE_ID]?.getSnapshot().input;

  return typeof input === "object" && input !== null && "revision" in input && typeof input.revision === "number"
    ? input.revision
    : undefined;
}

function getSaveSettleEvents(snapshot: WorkspaceSnapshot): ModelEvent[] {
  const savedRevision = resolveSavedRevision(snapshot);

  if (savedRevision === undefined) {
    return [];
  }

  return [
    { type: `xstate.done.actor.${SAVE_ID}`, output: savedRevision },
    { type: `xstate.error.actor.${SAVE_ID}`, error: saveOutcome.error },
  ];
}

function toModelState(snapshot: WorkspaceSnapshot) {
  const savedRevision = resolveSavedRevision(snapshot);

  return {
    value: snapshot.value,
    projects: snapshot.context.projects.map(({ name }) => name),
    queued: snapshot.context.queuedProjects.length,
    error: snapshot.context.error !== "",
    replaced: snapshot.context.replaced.length,
    recovered: snapshot.context.recovered.length > 0,
    changedWhileSaving: savedRevision !== undefined && savedRevision !== snapshot.context.revision,
  };
}

function startWorkspace() {
  const settler = createActorSettler();
  const machine = workspaceMachine.provide({
    actors: { load: settler.fromOutcome(loadOutcome), save: settler.fromOutcome(saveOutcome) },
  });

  return { actor: createActor(machine, { input: { storage } }).start(), settler };
}

const paths = getMachinePaths(workspaceMachine, {
  input: { storage },
  toModelState,
  describeEvent: (event) => (event.type === DEBOUNCE_EVENT.type ? "after 500 ms" : eventLabels.get(event)),
  events: (snapshot) => [
    changeToEmptyList,
    addProject,
    ...(snapshot.context.projects.length === 1 ? [mergeRemoval] : []),
    mergeReplacingEdits,
    { type: "store.retry" },
    { type: "save.flush" },
    { type: "replaced.dismiss" },
    { type: "recovered.dismiss" },
    ...(snapshot.matches("debouncing") ? [DEBOUNCE_EVENT] : []),
    ...getSettleEvents(snapshot, { load: loadOutcome }),
    ...getSaveSettleEvents(snapshot),
  ],
});

async function advanceTimers(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("workspace machine paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should take the same transitions", () => {
    expect(toTransitionTable(paths)).toMatchSnapshot();
  });

  for (const path of paths) {
    it(`should take ${path.description}`, async () => {
      const { actor, settler } = startWorkspace();

      await expect(
        replayMachinePath(path, {
          actor,
          settler,
          toModelState,
          advance: () => advanceTimers(500),
          flush: () => advanceTimers(0),
        }),
      ).resolves.toBeUndefined();
      actor.stop();
    });
  }
});
