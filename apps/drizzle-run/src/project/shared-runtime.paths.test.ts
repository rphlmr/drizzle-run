import { createActorSettler, getMachinePaths, replayMachinePath, toTransitionTable } from "@drizzle-run/machine-paths";
import type { BrowserRuntime } from "@drizzle-run/runtime/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assign, createActor, type SnapshotFrom } from "xstate";

import { sharedRuntimeMachine } from "./shared-runtime";

const MAX_HOLDERS = 2;
const DISPOSE_EVENT = { type: "xstate.after.0.sharedRuntime.lingering" } as const;

const runtime = new Promise<BrowserRuntime>(() => {});
const staleRuntime = new Promise<BrowserRuntime>(() => {});

function createFakeRuntimeMachine() {
  return sharedRuntimeMachine.provide({
    actions: {
      createRuntime: assign({ runtime }),
      disposeRuntime: vi.fn<() => void>(),
    },
  });
}

const fakeRuntimeMachine = createFakeRuntimeMachine();

// The graph tells events apart by their JSON, where every promise reads as {}.
const currentRuntimeFailed = { type: "runtime.failed", runtime, which: "current" } as const;
const staleRuntimeFailed = { type: "runtime.failed", runtime: staleRuntime, which: "earlier" } as const;
const eventLabels = new Map<object, string>([
  [currentRuntimeFailed, "runtime.failed of the current runtime"],
  [staleRuntimeFailed, "runtime.failed of an earlier runtime"],
  [DISPOSE_EVENT, "after 0 ms"],
]);

type SharedRuntimeSnapshot = SnapshotFrom<typeof fakeRuntimeMachine>;

function toModelState(snapshot: SharedRuntimeSnapshot) {
  return {
    value: snapshot.value,
    holders: snapshot.context.holders,
    runtime: snapshot.context.runtime !== undefined,
  };
}

const walks = [
  { label: "the page runtime slot", slot: 0 },
  { label: "the side runtime slot", slot: 1 },
] as const;

async function advanceTimers(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

async function flushMicrotasks() {
  await Promise.resolve();
}

describe("shared runtime machine paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  for (const { label, slot } of walks) {
    const paths = getMachinePaths(fakeRuntimeMachine, {
      input: { slot },
      toModelState,
      describeEvent: (event) => eventLabels.get(event),
      events: (snapshot) => [
        { type: "runtime.get" },
        currentRuntimeFailed,
        staleRuntimeFailed,
        ...(snapshot.context.holders < MAX_HOLDERS ? [{ type: "runtime.hold" }] : []),
        { type: "runtime.release" },
        ...(snapshot.matches("lingering") ? [DISPOSE_EVENT] : []),
      ],
    });

    describe(`${label} paths`, () => {
      it("should take the same transitions", () => {
        expect(toTransitionTable(paths)).toMatchSnapshot();
      });

      for (const path of paths) {
        it(`should take ${path.description}`, async () => {
          const actor = createActor(createFakeRuntimeMachine(), { input: { slot } }).start();

          await expect(
            replayMachinePath(path, {
              actor,
              settler: createActorSettler(),
              toModelState,
              advance: () => advanceTimers(0),
              flush: flushMicrotasks,
            }),
          ).resolves.toBeUndefined();
          actor.stop();
        });
      }
    });
  }
});
