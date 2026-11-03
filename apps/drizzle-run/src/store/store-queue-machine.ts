import { assign, fromPromise, setup } from "xstate";

import { declareType } from "../lib/declare-type";
import type { ProjectRecord } from "../project/projects";

/** What this tab knows about the store's copy of each project. */
export interface StoreRevisions {
  /** The revision this tab last knew the store held, by project id. */
  known: ReadonlyMap<string, number>;
  /** How many times this tab read each project back after another tab or a stale save changed it. */
  reloads: ReadonlyMap<string, number>;
}

/** A save, decided against what this tab knew when it was asked for. */
export interface ProjectWrite {
  changed: readonly ProjectRecord[];
  deletedIds: readonly string[];
  askedAt: ReadonlyMap<string, { knownRevision: number | undefined; reloadCount: number }>;
}

/** What a task leaves: the revisions it learned, and what to tell its caller once they are in place. */
export interface StoreTaskOutcome {
  revisions: StoreRevisions;
  settle(): void;
}

/** One read or write of the store's projects, which runs alone. */
export interface StoreTask {
  type: "load" | "write" | "reload";
  run(revisions: StoreRevisions): Promise<StoreTaskOutcome>;
  fail(cause: unknown): void;
}

/**
 * A task to queue. A save is planned against the revisions in place when the machine takes its event, so one a listener
 * sends while it hears a task settle sees what that task learned.
 */
export type StoreQueueEvent =
  | { type: "task.queued"; task: StoreTask }
  | { type: "write.queued"; projects: readonly ProjectRecord[]; createTask(write: ProjectWrite): StoreTask };

export const EMPTY_REVISIONS: StoreRevisions = { known: new Map(), reloads: new Map() };

/**
 * Plan a save of the workspace's projects
 *
 * Writes the projects new or changed since `revisions` and deletes the known ones no longer listed. Planned when the
 * save is asked for, so a change heard while the write waits never reads as a deletion.
 */
export function planProjectWrite(projects: readonly ProjectRecord[], revisions: StoreRevisions): ProjectWrite {
  const nextIds = new Set(projects.map((project) => project.id));
  const changed = structuredClone(projects.filter((project) => revisions.known.get(project.id) !== project.revision));

  return {
    changed,
    deletedIds: [...revisions.known.keys()].filter((id) => !nextIds.has(id)),
    askedAt: new Map(
      changed.map((project) => [
        project.id,
        {
          knownRevision: revisions.known.get(project.id),
          reloadCount: revisions.reloads.get(project.id) ?? 0,
        },
      ]),
    ),
  };
}

/**
 * Resolve the revision each written project was edited on
 *
 * Read when the write runs, after the saves queued before it, so each builds on the last. When the store's copy was read
 * back since the save was asked for, the edit was made on what this tab knew then: based on that, the store refuses it as
 * stale instead of writing it over a copy this tab never had.
 */
export function resolveBaseRevisions(write: ProjectWrite, revisions: StoreRevisions): Record<string, number> {
  const baseRevisions: Record<string, number> = {};

  for (const project of write.changed) {
    const asked = write.askedAt.get(project.id);
    const knownRevision =
      asked !== undefined && asked.reloadCount !== (revisions.reloads.get(project.id) ?? 0)
        ? asked.knownRevision
        : revisions.known.get(project.id);

    if (knownRevision !== undefined) {
      baseRevisions[project.id] = knownRevision;
    }
  }

  return baseRevisions;
}

/** The revisions after a write: deleted projects are forgotten, and written ones known at their new revision. */
export function applyProjectWrite(
  write: ProjectWrite,
  staleIds: ReadonlySet<string>,
  revisions: StoreRevisions,
): StoreRevisions {
  const known = new Map(revisions.known);

  for (const id of write.deletedIds) {
    known.delete(id);
  }

  for (const project of write.changed) {
    if (!staleIds.has(project.id)) {
      known.set(project.id, project.revision);
    }
  }

  return { known, reloads: revisions.reloads };
}

/** The revisions after reading projects back from the store: each one read or found deleted counts one more reload. */
export function applyProjectReload(
  projects: readonly ProjectRecord[],
  deletedIds: readonly string[],
  revisions: StoreRevisions,
): StoreRevisions {
  const known = new Map(revisions.known);
  const reloads = new Map(revisions.reloads);

  for (const id of deletedIds) {
    known.delete(id);
    reloads.set(id, (reloads.get(id) ?? 0) + 1);
  }

  for (const project of projects) {
    known.set(project.id, project.revision);
    reloads.set(project.id, (reloads.get(project.id) ?? 0) + 1);
  }

  return { known, reloads };
}

/**
 * Build the local store's task queue
 *
 * `idle` until a task is queued, then `running` one task at a time, in the order they were queued. A task settles
 * after its revisions are assigned, and a save sent while it settles is planned once they are in place. A failed task
 * changes no revision, and the next one runs.
 */
export function createStoreQueueMachine() {
  return setup({
    types: {
      context: declareType<{ revisions: StoreRevisions; tasks: readonly StoreTask[] }>(),
      events: declareType<StoreQueueEvent>(),
    },
    actors: {
      runTask: fromPromise<StoreTaskOutcome, { task: StoreTask; revisions: StoreRevisions }>(({ input }) =>
        input.task.run(input.revisions),
      ),
    },
    guards: {
      hasTasks: ({ context }) => context.tasks.length > 0,
    },
  }).createMachine({
    id: "storeQueue",
    initial: "idle",
    context: { revisions: EMPTY_REVISIONS, tasks: [] },
    on: {
      "task.queued": { actions: assign({ tasks: ({ context, event }) => [...context.tasks, event.task] }) },
      "write.queued": {
        actions: assign({
          tasks: ({ context, event }) => [
            ...context.tasks,
            event.createTask(planProjectWrite(event.projects, context.revisions)),
          ],
        }),
      },
    },
    states: {
      idle: {
        always: { guard: "hasTasks", target: "running" },
      },
      running: {
        invoke: {
          src: "runTask",
          input: ({ context }) => ({ task: toCurrentTask(context.tasks), revisions: context.revisions }),
          onDone: {
            target: "idle",
            actions: [
              assign({
                revisions: ({ event }) => event.output.revisions,
                tasks: ({ context }) => context.tasks.slice(1),
              }),
              ({ event }) => event.output.settle(),
            ],
          },
          onError: {
            target: "idle",
            actions: [
              ({ context, event }) => toCurrentTask(context.tasks).fail(event.error),
              assign({ tasks: ({ context }) => context.tasks.slice(1) }),
            ],
          },
        },
      },
    },
  });
}

/** The task `running` works on; `running` is entered only with one queued. */
function toCurrentTask(tasks: readonly StoreTask[]): StoreTask {
  const [task] = tasks;

  if (task === undefined) {
    throw new Error("Expected a queued store task while running, but the queue is empty.");
  }

  return task;
}
