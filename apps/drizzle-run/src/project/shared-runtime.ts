import type { BrowserRuntime } from "@drizzle-run/runtime/browser";
import { assign, createActor, setup } from "xstate";

import { declareType } from "../lib/declare-type";
import { getRuntimePolicy } from "../lib/runtime-policy";

type RuntimeSlot = 0 | 1;

type SharedRuntimeEvent =
  | { type: "runtime.get" }
  | { type: "runtime.failed"; runtime: Promise<BrowserRuntime> }
  | { type: "runtime.hold" }
  | { type: "runtime.release" };

interface SharedRuntimeContext {
  slot: RuntimeSlot;
  runtime: Promise<BrowserRuntime> | undefined;
  holders: number;
}

function createRuntime(): Promise<BrowserRuntime> {
  return import("@drizzle-run/runtime/browser").then((browser) =>
    browser.createBrowserRuntime({ preparation: getRuntimePolicy(globalThis.navigator).preparation }),
  );
}

/**
 * One runtime slot
 *
 * ```text
 * empty ─runtime.get─► active ─(last holder lets go)─► lingering ─(next task)─► empty, runtime disposed
 *                        ▲                                  │
 *                        └────────── runtime.hold ──────────┘
 * ```
 *
 * A creation that fails empties the slot, so the next `runtime.get` creates again. Slot 0 never lingers: it is the
 * page runtime and is never disposed.
 */
export const sharedRuntimeMachine = setup({
  types: {
    context: declareType<SharedRuntimeContext>(),
    events: declareType<SharedRuntimeEvent>(),
    input: declareType<{ slot: RuntimeSlot }>(),
  },
  guards: {
    isLastHolderOfSideSlot: ({ context }) => context.slot === 1 && context.holders <= 1,
    isCurrentRuntime: ({ context }, runtime: Promise<BrowserRuntime>) => context.runtime === runtime,
  },
  actions: {
    createRuntime: assign(({ self }) => {
      const runtime = createRuntime();
      runtime.catch(() => self.send({ type: "runtime.failed", runtime }));

      return { runtime };
    }),
    disposeRuntime: ({ context }) => {
      void context.runtime?.then((runtime) => runtime.dispose()).catch(() => undefined);
    },
    hold: assign({ holders: ({ context }) => context.holders + 1 }),
    release: assign({ holders: ({ context }) => Math.max(context.holders - 1, 0) }),
  },
}).createMachine({
  id: "sharedRuntime",
  initial: "empty",
  context: ({ input }) => ({ slot: input.slot, runtime: undefined, holders: 0 }),
  on: {
    "runtime.hold": { actions: "hold" },
    "runtime.release": { actions: "release" },
  },
  states: {
    empty: {
      on: {
        "runtime.get": { target: "active", actions: "createRuntime" },
      },
    },
    active: {
      on: {
        "runtime.failed": {
          guard: { type: "isCurrentRuntime", params: ({ event }) => event.runtime },
          target: "empty",
          actions: assign({ runtime: undefined }),
        },
        "runtime.release": [
          { guard: "isLastHolderOfSideSlot", target: "lingering", actions: "release" },
          { actions: "release" },
        ],
      },
    },
    lingering: {
      after: {
        0: { target: "empty", actions: ["disposeRuntime", assign({ runtime: undefined })] },
      },
      on: {
        "runtime.hold": { target: "active", actions: "hold" },
        "runtime.failed": {
          guard: { type: "isCurrentRuntime", params: ({ event }) => event.runtime },
          target: "empty",
          actions: assign({ runtime: undefined }),
        },
      },
    },
  },
});

const slots = [
  createActor(sharedRuntimeMachine, { input: { slot: 0 } }).start(),
  createActor(sharedRuntimeMachine, { input: { slot: 1 } }).start(),
] as const;

/**
 * Reuse runtime controllers across project switches. Slot 0 belongs to the page, while slot 1 supports the
 * second side's editor and readiness. Side readiness prepares on demand. The SDK executes comparisons in isolated
 * child runtimes, with a fresh guest and database per run.
 */
export function getSharedRuntime(slot: RuntimeSlot = 0): Promise<BrowserRuntime> {
  slots[slot].send({ type: "runtime.get" });
  const { runtime } = slots[slot].getSnapshot().context;

  if (runtime === undefined) {
    throw new Error(`Expected runtime slot ${slot} to hold a runtime once asked for one, but got none.`);
  }

  return runtime;
}

/**
 * Hold a side runtime
 *
 * Keeps slot 1 alive while a side-by-side view uses it, and returns its release. Once the last
 * holder lets go, the runtime is disposed on the next task unless another view takes it first, as
 * when one side-by-side project replaces another. Releasing the controller also disposes any resources it prepared.
 * Slot 0 belongs to the page and is not disposed when a view releases it.
 */
export function holdSharedRuntime(slot: RuntimeSlot): () => void {
  let released = false;
  slots[slot].send({ type: "runtime.hold" });

  return () => {
    if (released) {
      return;
    }

    released = true;
    slots[slot].send({ type: "runtime.release" });
  };
}
