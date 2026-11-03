import { tmpdir } from "node:os";

import { createActorSettler, getMachinePaths, replayMachinePath, toTransitionTable } from "@drizzle-run/machine-paths";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, fromCallback, type SnapshotFrom } from "xstate";

import { toDrizzleRunToolName } from "./agents/index.ts";
import { createTurnMachine, type TurnOptions } from "./turn.ts";

const BATCH_MS = 250;
const MAX_PENDING_TEXT_LENGTH = 4;
const STOP_GRACE_MS = 3_000;
const BATCH_EVENT = { type: "xstate.after.batch.turn.live.batch.waiting" } as const;
const STOP_GRACE_EVENT = { type: "xstate.after.stopGrace.turn.live.lifecycle.stopping" } as const;

function makeTurnOptions(): TurnOptions {
  return {
    command: "claude",
    args: [],
    prompt: "Hi",
    cwd: tmpdir(),
    env: {},
    onText: vi.fn<(text: string) => void>(),
    onSession: vi.fn<(id: string) => void>(),
    parser: () => [],
    allowedTools: ["get_project"],
    batchMs: BATCH_MS,
  };
}

const turnMachine = createTurnMachine(makeTurnOptions());

const textEvent = { type: "agent.text", text: "Hi" } as const;
const emptyTextEvent = { type: "agent.text", text: "" } as const;
const failedEvent = { type: "agent.failed", error: "Rate limited." } as const;
const unsafeEvent = { type: "agent.unsafe", reason: "The CLI runs with more than its lockdown allows." } as const;
const allowedToolEvent = { type: "agent.tool", name: toDrizzleRunToolName("get_project") } as const;
const otherToolEvent = { type: "agent.tool", name: "Bash" } as const;
const sessionEvent = { type: "agent.session", id: "session-1" } as const;
const stderrEvent = { type: "process.stderr", chunk: "boom\n" } as const;
const processErrorEvent = { type: "process.error", message: "spawn claude ENOENT" } as const;
const closedCleanly = { type: "process.closed", exitCode: 0 } as const;
const closedWithError = { type: "process.closed", exitCode: 1 } as const;
const eventLabels = new Map<object, string>([
  [textEvent, "agent.text"],
  [emptyTextEvent, "agent.text empty"],
  [allowedToolEvent, "agent.tool of Drizzle Run"],
  [otherToolEvent, "agent.tool beyond Drizzle Run"],
  [closedCleanly, "process.closed with code 0"],
  [closedWithError, "process.closed with code 1"],
  [BATCH_EVENT, `after ${BATCH_MS} ms`],
  [STOP_GRACE_EVENT, `after ${STOP_GRACE_MS} ms`],
]);

type TurnSnapshot = SnapshotFrom<typeof turnMachine>;

function toEndModel(snapshot: TurnSnapshot) {
  const { end } = snapshot.context;

  if (end === undefined) {
    return "none";
  }

  return end.state === "failed" ? `failed: ${end.error}` : end.state;
}

function toTextModelState(snapshot: TurnSnapshot) {
  return {
    value: snapshot.value,
    pendingText: snapshot.context.pendingText,
    boundary: snapshot.context.textBoundary,
    end: toEndModel(snapshot),
  };
}

function toEndModelState(snapshot: TurnSnapshot) {
  return {
    value: snapshot.value,
    failure: snapshot.context.failure !== undefined,
    refusal: snapshot.context.refusal !== undefined,
    stderr: snapshot.context.stderrTail !== "",
    end: toEndModel(snapshot),
  };
}

function getDelayEvents(snapshot: TurnSnapshot) {
  return [
    ...(snapshot.matches({ live: { batch: "waiting" } }) ? [BATCH_EVENT] : []),
    ...(snapshot.matches({ live: { lifecycle: "stopping" } }) ? [STOP_GRACE_EVENT] : []),
  ];
}

const walks = [
  {
    label: "text batching",
    toModelState: toTextModelState,
    events: (snapshot: TurnSnapshot) => [
      ...(snapshot.context.pendingText.length < MAX_PENDING_TEXT_LENGTH ? [textEvent] : []),
      emptyTextEvent,
      { type: "agent.message" },
      { type: "text.batched" },
      { type: "turn.stop" },
      closedCleanly,
      ...(snapshot.matches({ live: { batch: "waiting" } }) ? [BATCH_EVENT] : []),
    ],
  },
  {
    label: "how a turn ends",
    toModelState: toEndModelState,
    events: (snapshot: TurnSnapshot) => [
      failedEvent,
      unsafeEvent,
      allowedToolEvent,
      otherToolEvent,
      sessionEvent,
      stderrEvent,
      processErrorEvent,
      { type: "turn.stop" },
      closedCleanly,
      closedWithError,
      ...getDelayEvents(snapshot),
    ],
  },
];

function startTurnActor() {
  const machine = createTurnMachine(makeTurnOptions()).provide({
    actors: { agentProcess: fromCallback(() => {}) },
  });

  return { actor: createActor(machine).start(), settler: createActorSettler() };
}

async function advanceTimers(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("turn machine paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  for (const { label, toModelState, events } of walks) {
    const paths = getMachinePaths(turnMachine, {
      toModelState,
      describeEvent: (event) => eventLabels.get(event),
      events,
    });

    describe(`${label} paths`, () => {
      it("should take the same transitions", () => {
        expect(toTransitionTable(paths)).toMatchSnapshot();
      });

      for (const path of paths) {
        it(`should take ${path.description}`, async () => {
          const { actor, settler } = startTurnActor();

          await expect(
            replayMachinePath(path, {
              actor,
              settler,
              toModelState,
              advance: (event) => advanceTimers(event.type === BATCH_EVENT.type ? BATCH_MS : STOP_GRACE_MS),
              flush: () => advanceTimers(0),
            }),
          ).resolves.toBeUndefined();
          actor.stop();
        });
      }
    });
  }
});
