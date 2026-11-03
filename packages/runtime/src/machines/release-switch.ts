import { resolveGuestFlavor, type GuestFlavor, type SupportedRuntimeTuple } from "@drizzle-run/core/catalog";
import { moveManifestToPair, type RunManifest } from "@drizzle-run/core/manifest";
import { assign, emit, fromPromise, setup } from "xstate";

import { declareType } from "./declare-type.ts";
import { getErrorText } from "./error-text.ts";

/** A request to move a manifest to another release pair */
export interface ReleaseSwitchRequest {
  manifest: RunManifest;
  tuple: SupportedRuntimeTuple;
  /** The guest flavor to move to; without it the manifest keeps its flavor where the pair ships it. */
  guestFlavor?: GuestFlavor;
}

/** The host's services for the release switch */
export interface ReleaseSwitchServices {
  /** Moves the manifest to the pair, keeping files. Defaults to `moveManifestToPair`. */
  move?: (request: ReleaseSwitchRequest) => RunManifest | Promise<RunManifest>;
  /**
   * Hands the moved manifest to the host, which saves it. Its readiness flow then
   * prepares the runtime and the type environment for the new pair.
   */
  apply(manifest: RunManifest, tuple: SupportedRuntimeTuple): void | Promise<void>;
}

/** The release switch machine's input */
export interface ReleaseSwitchInput {
  /** A guide pins its pair, so switching is refused while locked. */
  locked?: boolean;
}

interface ReleaseSwitchContext {
  locked: boolean;
  request: ReleaseSwitchRequest | undefined;
  moved: RunManifest | undefined;
  error: string;
}

/** Public events. Their names are part of the runtime's API. */
export type ReleaseSwitchEvent =
  | { type: "release.switch"; manifest: RunManifest; tuple: SupportedRuntimeTuple; guestFlavor?: GuestFlavor }
  | { type: "release.retry" }
  | { type: "release.dismiss" }
  | { type: "release.lock" }
  | { type: "release.unlock" };

/** Emitted when a switch was applied, or when it failed */
export type ReleaseSwitchEmitted =
  | { type: "release.switched"; manifest: RunManifest; tuple: SupportedRuntimeTuple }
  | { type: "release.switch.failed"; error: string };

function isSameRelease(manifest: RunManifest, tuple: SupportedRuntimeTuple, guestFlavor: GuestFlavor | undefined) {
  return (
    manifest.dependencies["drizzle-orm"] === tuple.ormVersion &&
    manifest.dependencies["drizzle-kit"] === tuple.kitVersion &&
    (guestFlavor === undefined || guestFlavor === resolveGuestFlavor(manifest))
  );
}

/**
 * Release switch machine
 *
 * Moves a manifest to another release pair of the same dialect, or the same pair in another guest flavor, keeping its
 * files, then hands it to the host. Refuses the switch while locked by a guide; switching to the current pair and
 * flavor is a no-op.
 */
export const releaseSwitchMachine = setup({
  types: {
    input: declareType<ReleaseSwitchInput>(),
    context: declareType<ReleaseSwitchContext>(),
    events: declareType<ReleaseSwitchEvent>(),
    emitted: declareType<ReleaseSwitchEmitted>(),
  },
  actors: {
    move: fromPromise<RunManifest, ReleaseSwitchRequest>(async ({ input }) =>
      moveManifestToPair(input.manifest, input.tuple, input.guestFlavor),
    ),
    apply: fromPromise<void, { manifest: RunManifest; tuple: SupportedRuntimeTuple }>(async () => {
      throw new Error("The release switch needs an apply service. Build it with createReleaseSwitchMachine.");
    }),
  },
  guards: {
    /** Switching is refused inside a guide and is a no-op on the current pair. */
    canSwitch: ({ context, event }) =>
      !context.locked &&
      event.type === "release.switch" &&
      event.tuple.target.dialect === event.manifest.target.dialect &&
      !isSameRelease(event.manifest, event.tuple, event.guestFlavor),
  },
  actions: {
    request: assign(({ event }) =>
      event.type === "release.switch"
        ? { request: { manifest: event.manifest, tuple: event.tuple, guestFlavor: event.guestFlavor }, error: "" }
        : {},
    ),
  },
}).createMachine({
  id: "releaseSwitch",
  initial: "idle",
  context: ({ input }) => ({ locked: input.locked ?? false, request: undefined, moved: undefined, error: "" }),
  on: {
    "release.lock": { actions: assign({ locked: true }) },
    "release.unlock": { actions: assign({ locked: false }) },
  },
  states: {
    idle: {
      on: { "release.switch": { guard: "canSwitch", target: "moving", actions: "request" } },
    },
    moving: {
      invoke: {
        src: "move",
        input: ({ context }) => {
          if (context.request === undefined) {
            throw new Error("No release switch was requested.");
          }

          return context.request;
        },
        onDone: { target: "applying", actions: assign({ moved: ({ event }) => event.output }) },
        onError: { target: "failed", actions: assign({ error: ({ event }) => getErrorText(event.error) }) },
      },
    },
    applying: {
      invoke: {
        src: "apply",
        input: ({ context }) => {
          if (context.request === undefined || context.moved === undefined) {
            throw new Error("No moved manifest to apply.");
          }

          return { manifest: context.moved, tuple: context.request.tuple };
        },
        onDone: {
          target: "idle",
          actions: [
            emit(({ context }): ReleaseSwitchEmitted =>
              context.request && context.moved
                ? { type: "release.switched", manifest: context.moved, tuple: context.request.tuple }
                : { type: "release.switch.failed", error: "No moved manifest to apply." },
            ),
            assign({ request: undefined, moved: undefined }),
          ],
        },
        onError: { target: "failed", actions: assign({ error: ({ event }) => getErrorText(event.error) }) },
      },
    },
    failed: {
      entry: emit(({ context }): ReleaseSwitchEmitted => ({ type: "release.switch.failed", error: context.error })),
      on: {
        "release.switch": { guard: "canSwitch", target: "moving", actions: "request" },
        "release.retry": {
          guard: ({ context }) => !context.locked,
          target: "moving",
          actions: assign({ error: "", moved: undefined }),
        },
        "release.dismiss": { target: "idle", actions: assign({ request: undefined, moved: undefined, error: "" }) },
      },
    },
  },
});

/** Builds the release switch with the host's services. */
export function createReleaseSwitchMachine(services: ReleaseSwitchServices) {
  const move = services.move;

  return releaseSwitchMachine.provide({
    actors: {
      ...(move ? { move: fromPromise<RunManifest, ReleaseSwitchRequest>(async ({ input }) => move(input)) } : {}),
      apply: fromPromise<void, { manifest: RunManifest; tuple: SupportedRuntimeTuple }>(async ({ input }) => {
        await services.apply(input.manifest, input.tuple);
      }),
    },
  });
}
