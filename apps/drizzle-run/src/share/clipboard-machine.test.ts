import {
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, SimulatedClock, waitFor, type SnapshotFrom } from "xstate";

import { CLIPBOARD_WRITE_ACTOR_ID, COPIED_FEEDBACK_MS, createClipboardMachine } from "./clipboard-machine";

const clipboardMachine = createClipboardMachine({ writeText: async () => {} });
const resetEvent = { type: `xstate.after.${COPIED_FEEDBACK_MS}.clipboard.copied` } as const;
const outcomes = { [CLIPBOARD_WRITE_ACTOR_ID]: { outputs: [undefined], error: new Error("Permission denied") } };

function toModelState(snapshot: SnapshotFrom<typeof clipboardMachine>) {
  return { value: snapshot.value, text: snapshot.context.text };
}

const paths = getMachinePaths(clipboardMachine, {
  toModelState,
  events: (snapshot) => [
    { type: "clipboard.copy", text: "link", message: "Link copied." },
    ...(snapshot.matches("copied") ? [resetEvent] : []),
    ...getSettleEvents(snapshot, outcomes),
  ],
});

describe("clipboard machine paths", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("should preserve the transition table", () => {
    expect(toTransitionTable(paths)).toMatchSnapshot();
  });

  for (const path of paths) {
    it(`should take ${path.description}`, async () => {
      const settler = createActorSettler();
      const actor = createActor(
        clipboardMachine.provide({
          actors: {
            writeText: settler.fromOutcome<void, string>(outcomes[CLIPBOARD_WRITE_ACTOR_ID]),
          },
        }),
      ).start();

      try {
        await expect(
          replayMachinePath(path, {
            actor,
            settler,
            toModelState,
            advance: async () => {
              await vi.advanceTimersByTimeAsync(COPIED_FEEDBACK_MS);
            },
            flush: async () => {
              await vi.advanceTimersByTimeAsync(0);
            },
          }),
        ).resolves.toBeUndefined();
      } finally {
        actor.stop();
      }
    });
  }
});

describe("clipboard machine", () => {
  it("should reset success after two seconds and restart the timer on another copy", async () => {
    const clock = new SimulatedClock();
    const actor = createActor(createClipboardMachine({ writeText: async () => {} }), { clock }).start();

    try {
      actor.send({ type: "clipboard.copy", text: "first", message: "First copied." });
      await waitFor(actor, (snapshot) => snapshot.matches("copied"));
      clock.increment(COPIED_FEEDBACK_MS - 1);
      expect(actor.getSnapshot().matches("copied")).toBe(true);

      actor.send({ type: "clipboard.copy", text: "second", message: "Second copied." });
      await waitFor(actor, (snapshot) => snapshot.matches("copied"));
      clock.increment(1);
      expect(actor.getSnapshot().matches("copied")).toBe(true);
      expect(actor.getSnapshot().context.text).toBe("second");
      clock.increment(COPIED_FEEDBACK_MS - 1);
      expect(actor.getSnapshot().matches("idle")).toBe(true);
    } finally {
      actor.stop();
    }
  });

  it("should ignore an older clipboard result when a newer copy failed", async () => {
    const first = Promise.withResolvers<void>();
    const actor = createActor(
      createClipboardMachine({
        writeText: (text) => (text === "first" ? first.promise : Promise.reject(new Error("Permission denied"))),
      }),
    ).start();

    try {
      actor.send({ type: "clipboard.copy", text: "first", message: "First copied." });
      actor.send({ type: "clipboard.copy", text: "second", message: "Second copied." });
      await waitFor(actor, (snapshot) => snapshot.matches("failed"));
      first.resolve();
      await first.promise;

      expect(actor.getSnapshot().matches("failed")).toBe(true);
      expect(actor.getSnapshot().context.text).toBe("second");
    } finally {
      actor.stop();
    }
  });

  it("should allow another copy after failure and cancel feedback on unmount", async () => {
    const clock = new SimulatedClock();
    let denied = true;
    const actor = createActor(
      createClipboardMachine({
        writeText: async () => {
          if (denied) {
            throw new Error("Permission denied");
          }
        },
      }),
      { clock },
    ).start();

    actor.send({ type: "clipboard.copy", text: "link", message: "Link copied." });
    await waitFor(actor, (snapshot) => snapshot.matches("failed"));
    denied = false;
    actor.send({ type: "clipboard.copy", text: "link", message: "Link copied." });
    await waitFor(actor, (snapshot) => snapshot.matches("copied"));
    actor.stop();
    clock.increment(COPIED_FEEDBACK_MS);

    expect(actor.getSnapshot().status).toBe("stopped");
  });
});
