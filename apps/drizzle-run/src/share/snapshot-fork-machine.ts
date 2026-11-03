import { assign, emit, fromPromise, setup, type ActorRefFrom } from "xstate";

import { declareType } from "../lib/declare-type";
import type { ProjectRecord } from "../project/projects";

/** A fork asked for by the Fork button, which opens it, or by `fork_project`, which leaves the shared link in front. */
export interface ForkRequest {
  requestId: string;
  name: string;
  open: boolean;
}

/** What the snapshot fork machine hears. */
export type SnapshotForkEvent = { type: "fork.request" } & ForkRequest;

/** What the snapshot fork machine tells its requesters. */
export type SnapshotForkEmitted =
  | { type: "fork.saved"; request: ForkRequest; project: ProjectRecord }
  | { type: "fork.failed"; request: ForkRequest; error: string }
  | { type: "fork.refused"; request: ForkRequest };

interface SnapshotForkContext {
  request: ForkRequest | undefined;
  /** Why the last fork the button asked for failed; a `fork_project` failure goes back to the agent instead. */
  error: string;
}

/** Saves the fork named `name` in this browser and returns it. */
export type SaveFork = (name: string) => Promise<ProjectRecord>;

function toForkError(cause: unknown) {
  return cause instanceof Error ? cause.message : "The project could not be saved locally.";
}

/**
 * Create the snapshot fork machine
 *
 * ```text
 * idle ─fork.request─► saving ─(saved or failed)─► idle
 * ```
 *
 * One fork saves at a time, whoever asks: a request while one saves is refused, so a double click or the agent
 * forking while the button does never saves two copies.
 */
export function createSnapshotForkMachine({ saveFork }: { saveFork: SaveFork }) {
  return setup({
    types: {
      context: declareType<SnapshotForkContext>(),
      events: declareType<SnapshotForkEvent>(),
      emitted: declareType<SnapshotForkEmitted>(),
    },
    actors: {
      saveFork: fromPromise<ProjectRecord, string>(({ input }) => saveFork(input)),
    },
  }).createMachine({
    id: "snapshotFork",
    initial: "idle",
    context: { request: undefined, error: "" },
    states: {
      idle: {
        on: {
          "fork.request": {
            target: "saving",
            actions: assign({
              request: ({ event: { requestId, name, open } }) => ({ requestId, name, open }),
              error: "",
            }),
          },
        },
      },
      saving: {
        invoke: {
          src: "saveFork",
          input: ({ context }) => getRequest(context).name,
          onDone: {
            target: "idle",
            actions: [
              emit(({ context, event }) => ({
                type: "fork.saved" as const,
                request: getRequest(context),
                project: event.output,
              })),
              assign({ request: undefined }),
            ],
          },
          onError: {
            target: "idle",
            actions: [
              emit(({ context, event }) => ({
                type: "fork.failed" as const,
                request: getRequest(context),
                error: toForkError(event.error),
              })),
              assign({
                error: ({ context, event }) => (getRequest(context).open ? toForkError(event.error) : ""),
                request: undefined,
              }),
            ],
          },
        },
        on: {
          "fork.request": {
            actions: emit(({ event: { requestId, name, open } }) => ({
              type: "fork.refused" as const,
              request: { requestId, name, open },
            })),
          },
        },
      },
    },
  });
}

function getRequest(context: SnapshotForkContext): ForkRequest {
  if (context.request === undefined) {
    throw new Error("Expected the fork being saved to have its request, but got none.");
  }

  return context.request;
}

/** A running snapshot fork machine. */
export type SnapshotForkActor = ActorRefFrom<ReturnType<typeof createSnapshotForkMachine>>;

/**
 * Ask for a fork and wait for it
 *
 * Resolves with the saved project. Rejects with the reason the save failed, when another fork is saving, or when the
 * page closes first.
 */
export function requestFork(actor: SnapshotForkActor, { name, open }: { name: string; open: boolean }) {
  return new Promise<ProjectRecord>((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const isThisRequest = (request: ForkRequest) => request.requestId === requestId;
    const subscriptions = [
      actor.on("fork.saved", ({ request, project }) => {
        if (isThisRequest(request)) {
          stopListening();
          resolve(project);
        }
      }),
      actor.on("fork.failed", ({ request, error }) => {
        if (isThisRequest(request)) {
          stopListening();
          reject(new Error(error));
        }
      }),
      actor.on("fork.refused", ({ request }) => {
        if (isThisRequest(request)) {
          stopListening();
          reject(new Error("Another fork is being saved. Try again once it is done."));
        }
      }),
      actor.subscribe({
        complete: () => {
          stopListening();
          reject(new Error("The shared link closed before the fork was saved."));
        },
      }),
    ];

    function stopListening() {
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
    }

    actor.send({ type: "fork.request", requestId, name, open });
  });
}
