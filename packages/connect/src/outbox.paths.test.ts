import {
  type ActorOutcome,
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, type SnapshotFrom } from "xstate";

import { createOutboxMachine } from "./outbox.ts";

interface TestItem {
  key: string;
  text: string;
}

const BURST = 2;
const PER_SECOND = 2;
const TOKEN_INTERVAL_MS = 1_000 / PER_SECOND;
const MAX_QUEUED_ITEMS = 2;
const TOKEN_EVENT = { type: "xstate.after.untilToken.outbox.waitingForToken" } as const;

function mergeSameKey(earlier: TestItem, later: TestItem): TestItem | undefined {
  return earlier.key === later.key ? { key: earlier.key, text: earlier.text + later.text } : undefined;
}

/**
 * The walk cannot let time pass, so its clock jumps by one token whenever the state it explores waits for one. The graph
 * asks for a state's events right before it takes them, so the clock holds while that state's transitions run.
 */
let walkClockMs = 0;

const outboxMachine = createOutboxMachine<TestItem>({
  deliver: async () => {},
  merge: mergeSameKey,
  burst: BURST,
  perSecond: PER_SECOND,
  now: () => walkClockMs,
});

const deliverOutcome: ActorOutcome<void> = { outputs: [undefined], error: new Error("The relay refused the frame.") };
const outcomes = { deliver: deliverOutcome };

const pushA = { type: "item.push", item: { key: "a", text: "a" } } as const;
const pushB = { type: "item.push", item: { key: "b", text: "b" } } as const;
const dropA = { type: "items.drop", isDropped: (item: TestItem) => item.key === "a" } as const;
const eventLabels = new Map<object, string>([
  [pushA, "item.push a"],
  [pushB, "item.push b"],
  [dropA, "items.drop a"],
  [TOKEN_EVENT, `after ${TOKEN_INTERVAL_MS} ms`],
]);

type OutboxSnapshot = SnapshotFrom<typeof outboxMachine>;

function toModelState(snapshot: OutboxSnapshot) {
  const { queue, delivering, tokens } = snapshot.context;

  return {
    value: snapshot.value,
    queue: queue.map((item) => item.text).join(","),
    delivering: delivering?.item.text ?? "none",
    tokens,
  };
}

const paths = getMachinePaths(outboxMachine, {
  toModelState,
  describeEvent: (event) => eventLabels.get(event),
  events: (snapshot) => {
    const isWaitingForToken = snapshot.matches("waitingForToken");

    walkClockMs = snapshot.context.refilledAt + (isWaitingForToken ? TOKEN_INTERVAL_MS : 0);

    return [
      ...(snapshot.context.queue.length < MAX_QUEUED_ITEMS ? [pushA, pushB] : []),
      dropA,
      { type: "items.clear" },
      ...(isWaitingForToken ? [TOKEN_EVENT] : []),
      ...getSettleEvents(snapshot, outcomes),
    ];
  },
});

function startOutbox() {
  const settler = createActorSettler();
  const machine = createOutboxMachine<TestItem>({
    deliver: async () => {},
    merge: mergeSameKey,
    burst: BURST,
    perSecond: PER_SECOND,
    now: () => Date.now(),
  }).provide({
    actors: { deliver: settler.fromOutcome(deliverOutcome) },
  });

  return { actor: createActor(machine).start(), settler };
}

async function advanceTimers(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("outbox machine paths", () => {
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
      const { actor, settler } = startOutbox();

      await expect(
        replayMachinePath(path, {
          actor,
          settler,
          toModelState,
          advance: () => advanceTimers(TOKEN_INTERVAL_MS),
          flush: () => advanceTimers(0),
        }),
      ).resolves.toBeUndefined();
      actor.stop();
    });
  }
});
