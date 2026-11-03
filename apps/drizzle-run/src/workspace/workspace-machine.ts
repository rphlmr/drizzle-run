import { isEqual, omit } from "es-toolkit";
import { assign, fromPromise, setup, type ActorRefFrom } from "xstate";

import { declareType } from "../lib/declare-type";
import { duplicateProject, type ProjectRecord } from "../project/projects";
import type { ExternalProjectChange, ProjectStorage } from "../store/storage";

/** A project named in a workspace's replacement or recovery notice. */
export interface WorkspaceProjectNotice {
  id: string;
  name: string;
}

function hasPendingRemoval(projects: readonly ProjectRecord[], change: ExternalProjectChange): boolean {
  return projects.some((project) => isPendingRemoval(project, change));
}

function isPendingRemoval(project: ProjectRecord, change: ExternalProjectChange): boolean {
  const knownRevision = change.knownRevisions[project.id];

  return change.deletedIds.includes(project.id) && knownRevision !== undefined && project.revision !== knownRevision;
}

/**
 * Merge projects changed outside this workspace
 *
 * Takes the incoming copy of a project when it is newer than the one here or new to this list, and drops deleted ids.
 * Pending edits to deleted projects become new Local copies, without restoring the original or its Cloud association.
 * The first tab to save a revision wins: a copy here with edits the store never took (its revision is not the one this
 * tab last knew the store held) gives way to a revision another tab saved since, and is listed in `replaced` so this
 * tab can say its edits were lost. Without newer saves elsewhere it stays, to be saved. The same revision with other
 * content means both tabs edited from one revision: the store kept the other tab's copy, so this tab takes it rather
 * than showing "Saved" for edits that are nowhere.
 */
export function mergeExternalProjects(
  projects: readonly ProjectRecord[],
  change: ExternalProjectChange,
): { projects: ProjectRecord[]; replaced: WorkspaceProjectNotice[]; recovered: WorkspaceProjectNotice[] } {
  const deleted = new Set(change.deletedIds);
  const incoming = new Map(change.projects.map((project) => [project.id, project]));
  const replaced: WorkspaceProjectNotice[] = [];
  const copies = projects
    .filter((project) => isPendingRemoval(project, change))
    .map((project) => duplicateProject(project));
  const recovered = copies.map(({ id, name }) => ({ id, name }));
  const merged = projects
    .filter((project) => !deleted.has(project.id))
    .map((project) => {
      const external = incoming.get(project.id);
      incoming.delete(project.id);

      if (external === undefined) {
        return project;
      }

      const sameContent = isEqual(omit(external, ["updatedAt"]), omit(project, ["updatedAt"]));
      const knownRevision = change.knownRevisions[project.id];
      const hasUnsavedEdits = knownRevision !== undefined && knownRevision !== project.revision;

      if (hasUnsavedEdits) {
        if (external.revision <= knownRevision || sameContent) {
          return project;
        }

        replaced.push({ id: project.id, name: project.name });

        return external;
      }

      if (external.revision < project.revision || (external.revision === project.revision && sameContent)) {
        return project;
      }

      return external;
    });

  return { projects: [...merged, ...incoming.values(), ...copies], replaced, recovered };
}

/** What the workspace machine hears from the app and from the store. */
export type WorkspaceEvent =
  | { type: "projects.change"; projects: ProjectRecord[] }
  | { type: "projects.add"; projects: readonly ProjectRecord[] }
  | ({ type: "projects.merge" } & ExternalProjectChange)
  | { type: "store.retry" }
  | { type: "save.flush" }
  | { type: "replaced.dismiss" }
  | { type: "recovered.dismiss" };

/** The workspace machine's context. */
export interface WorkspaceMachineContext {
  storage: ProjectStorage;
  projects: ProjectRecord[];
  /** Counts the changes made here; a save settles the revision it wrote. */
  revision: number;
  /** Projects added before the stored ones loaded, saved beside them once they do. */
  queuedProjects: ProjectRecord[];
  error: string;
  /** Projects whose edits here another tab's save replaced, until the user dismisses the notice. */
  replaced: WorkspaceProjectNotice[];
  /** Local copies preserving edits to projects removed elsewhere. */
  recovered: WorkspaceProjectNotice[];
}

function appendNewProjects(projects: readonly ProjectRecord[], added: readonly ProjectRecord[]): ProjectRecord[] {
  const knownIds = new Set(projects.map((project) => project.id));

  return [...projects, ...added.filter((project) => !knownIds.has(project.id))];
}

/**
 * The workspace's projects in the local store
 *
 * ```text
 * loading ─► saved ─projects.change | projects.add─► debouncing ─500 ms | save.flush─► saving ─► saved
 *        │                                                                      saving ─► saveError ─store.retry─► saving
 *        ├► saving (projects added while loading)
 *        └► loadError ─store.retry─► loading
 * ```
 *
 * A project added while the store loads waits in `queuedProjects` and saves beside the loaded ones. A full-list
 * change before the load is refused: it was made without the stored projects. `projects.merge` takes what another tab
 * saved. Pending edits to a removed project are copied and saved locally.
 */
export const workspaceMachine = setup({
  types: {
    context: declareType<WorkspaceMachineContext>(),
    input: declareType<{ storage: ProjectStorage }>(),
    events: declareType<WorkspaceEvent>(),
  },
  actors: {
    load: fromPromise(({ input }: { input: ProjectStorage }) => input.load()),
    save: fromPromise(
      async ({ input }: { input: { storage: ProjectStorage; projects: ProjectRecord[]; revision: number } }) => {
        await input.storage.save(input.projects);
        return input.revision;
      },
    ),
  },
  guards: {
    hasQueuedProjects: ({ context }) => context.queuedProjects.length > 0,
    hasPendingRemoval: ({ context }, change: ExternalProjectChange) => hasPendingRemoval(context.projects, change),
    isOutdated: ({ context }, savedRevision: number) => context.revision !== savedRevision,
  },
  actions: {
    change: assign(({ context }, projects: ProjectRecord[]) => ({ projects, revision: context.revision + 1 })),
    add: assign(({ context }, added: readonly ProjectRecord[]) => ({
      projects: appendNewProjects(context.projects, added),
      revision: context.revision + 1,
    })),
    queue: assign(({ context }, added: readonly ProjectRecord[]) => ({
      queuedProjects: appendNewProjects(context.queuedProjects, added),
      revision: context.revision + 1,
    })),
    applyLoaded: assign(({ context }, loaded: ProjectRecord[]) => ({
      projects: appendNewProjects(loaded, context.queuedProjects),
      queuedProjects: [],
      error: "",
    })),
    mergeExternal: assign(({ context }, change: ExternalProjectChange) => {
      const { projects, replaced, recovered } = mergeExternalProjects(context.projects, change);
      const replacedIds = new Set(replaced.map((project) => project.id));

      return {
        projects,
        replaced: [...context.replaced.filter((project) => !replacedIds.has(project.id)), ...replaced],
        recovered: [...context.recovered, ...recovered],
        revision: context.revision + (recovered.length > 0 ? 1 : 0),
      };
    }),
  },
}).createMachine({
  id: "workspace",
  initial: "loading",
  context: ({ input }) => ({
    storage: input.storage,
    projects: [],
    revision: 0,
    queuedProjects: [],
    error: "",
    replaced: [],
    recovered: [],
  }),
  on: {
    "projects.merge": [
      {
        guard: { type: "hasPendingRemoval", params: ({ event }) => event },
        target: ".saving",
        actions: { type: "mergeExternal", params: ({ event }) => event },
      },
      { actions: { type: "mergeExternal", params: ({ event }) => event } },
    ],
    "replaced.dismiss": { actions: assign({ replaced: [] }) },
    "recovered.dismiss": { actions: assign({ recovered: [] }) },
  },
  states: {
    loading: {
      on: {
        "projects.add": { actions: { type: "queue", params: ({ event }) => event.projects } },
      },
      invoke: {
        src: "load",
        input: ({ context }) => context.storage,
        onDone: [
          {
            guard: "hasQueuedProjects",
            target: "saving",
            actions: { type: "applyLoaded", params: ({ event }) => event.output },
          },
          { target: "saved", actions: { type: "applyLoaded", params: ({ event }) => event.output } },
        ],
        onError: { target: "loadError", actions: assign({ error: ({ event }) => String(event.error) }) },
      },
    },
    loadError: {
      on: {
        "projects.add": { actions: { type: "queue", params: ({ event }) => event.projects } },
        "store.retry": "loading",
      },
    },
    saved: {
      on: {
        "projects.change": { target: "debouncing", actions: { type: "change", params: ({ event }) => event.projects } },
        "projects.add": { target: "debouncing", actions: { type: "add", params: ({ event }) => event.projects } },
      },
    },
    debouncing: {
      after: { 500: "saving" },
      on: {
        "projects.change": {
          target: "debouncing",
          reenter: true,
          actions: { type: "change", params: ({ event }) => event.projects },
        },
        "projects.add": {
          target: "debouncing",
          reenter: true,
          actions: { type: "add", params: ({ event }) => event.projects },
        },
        "save.flush": "saving",
      },
    },
    saving: {
      on: {
        "projects.merge": { actions: { type: "mergeExternal", params: ({ event }) => event } },
        "projects.change": { actions: { type: "change", params: ({ event }) => event.projects } },
        "projects.add": { actions: { type: "add", params: ({ event }) => event.projects } },
      },
      invoke: {
        src: "save",
        input: ({ context }) => ({ storage: context.storage, projects: context.projects, revision: context.revision }),
        onDone: [
          {
            guard: { type: "isOutdated", params: ({ event }) => event.output },
            target: "saving",
            reenter: true,
          },
          { target: "saved", actions: assign({ error: "" }) },
        ],
        onError: { target: "saveError", actions: assign({ error: ({ event }) => String(event.error) }) },
      },
    },
    saveError: {
      on: {
        "projects.change": { actions: { type: "change", params: ({ event }) => event.projects } },
        "projects.add": { actions: { type: "add", params: ({ event }) => event.projects } },
        "store.retry": "saving",
      },
    },
  },
});

/**
 * Wait until the store holds a revision
 *
 * Settles once the workspace saved `revision` or a later one, and rejects when that save or the load before it failed. Another tab reads
 * the store, so a project another tab opens by link must be saved first.
 */
export function waitUntilSaved(actor: ActorRefFrom<typeof workspaceMachine>, revision: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const snapshot = actor.getSnapshot();

      if (snapshot.matches("saveError") || snapshot.matches("loadError")) {
        subscription?.unsubscribe();
        reject(new Error(`The project was not saved in this browser: ${snapshot.context.error}`));
        return;
      }

      if (snapshot.matches("saved") && snapshot.context.revision >= revision) {
        subscription?.unsubscribe();
        resolve();
      }
    };
    let subscription: { unsubscribe(): void } | undefined;

    subscription = actor.subscribe(check);
    check();
  });
}
