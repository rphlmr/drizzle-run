import { RELAY_CLOSE } from "@drizzle-run/core/connect";
import { createActorSettler, getMachinePaths, replayMachinePath, toTransitionTable } from "@drizzle-run/machine-paths";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, fromCallback, type SnapshotFrom } from "xstate";

import { createRelayMachine, type RelayHandlers, type RelaySocketLike } from "./relay.ts";

const RETRY_EVENT = { type: "xstate.after.retry.relay.waitingRetry" } as const;

const socket: RelaySocketLike = { send: vi.fn(), close: vi.fn(), addEventListener: vi.fn() };

function makeOptions(handlers: RelayHandlers) {
  return { url: "ws://relay.test/room", protocols: [], handlers, open: () => socket };
}

const relayMachine = createRelayMachine(makeOptions({ frame: vi.fn(), closed: vi.fn() }));

const socketCreated = { type: "socket.created", socket } as const;
const welcomeFrame = {
  type: "socket.frame",
  frame: { t: "welcome", id: "comp1", role: "companion", peers: [], maxFrameBytes: 524_288 },
} as const;
const dataFrame = { type: "socket.frame", frame: { t: "data", from: "tab1", d: "sealed" } } as const;
const closedReplaced = { type: "socket.closed", code: RELAY_CLOSE.replaced } as const;
const closedRateLimited = { type: "socket.closed", code: RELAY_CLOSE.rateLimited } as const;
const closedAbnormally = { type: "socket.closed", code: 1006 } as const;
const eventLabels = new Map<object, string>([
  [welcomeFrame, "socket.frame welcome"],
  [dataFrame, "socket.frame data"],
  [closedReplaced, "socket.closed replaced"],
  [closedRateLimited, "socket.closed rate limited"],
  [closedAbnormally, "socket.closed abnormally"],
  [RETRY_EVENT, "after the retry delay"],
]);

function toModelState(snapshot: SnapshotFrom<typeof relayMachine>) {
  return { value: snapshot.value, attempt: snapshot.context.attempt };
}

const paths = getMachinePaths(relayMachine, {
  toModelState,
  describeEvent: (event) => eventLabels.get(event),
  events: (snapshot) => [
    { type: "relay.start" },
    { type: "relay.close" },
    socketCreated,
    welcomeFrame,
    dataFrame,
    closedReplaced,
    closedRateLimited,
    closedAbnormally,
    ...(snapshot.matches("waitingRetry") ? [RETRY_EVENT] : []),
  ],
});

function startRelay() {
  let retryInMs = 0;
  const handlers: RelayHandlers = {
    frame: vi.fn(),
    closed: (_code, delay) => {
      retryInMs = delay ?? 0;
    },
  };
  const machine = createRelayMachine(makeOptions(handlers)).provide({
    actors: { socket: fromCallback(() => {}) },
  });

  return { actor: createActor(machine).start(), settler: createActorSettler(), getRetryInMs: () => retryInMs };
}

async function advanceTimers(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("relay machine paths", () => {
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
      const { actor, settler, getRetryInMs } = startRelay();

      await expect(
        replayMachinePath(path, {
          actor,
          settler,
          toModelState,
          advance: () => advanceTimers(getRetryInMs()),
          flush: () => advanceTimers(0),
        }),
      ).resolves.toBeUndefined();
      actor.stop();
    });
  }
});
