import { CONNECT_LIMITS, RELAY_CLOSE, type CompanionInfo } from "@drizzle-run/core/connect";
import {
  type ActorOutcome,
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  type ModelEvent,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, fromPromise, type SnapshotFrom } from "xstate";

import type { ConnectPairing, ConnectServices, ConnectToolRequest, PendingEdit } from "./connect-contract.ts";
import { createConnectMachine } from "./connect.ts";

const MAX_DELAY_MS = 30_000;
const COMPANION = "comp1";
const OTHER_COMPANION = "comp2";
const CALL_ID = "call-1";
const EDIT_ID = `edit-${CALL_ID}`;
const CONVERSATION = "project:p1";

const unconfirmed: ConnectPairing = { secret: "k7Pq-2xZm-9fLw", pairedAt: "2026-10-15T10:00:00.000Z" };
const confirmed: ConnectPairing = { ...unconfirmed, confirmedAt: "2026-10-15T10:01:00.000Z" };
const chatCompanion: CompanionInfo = {
  version: "0.1.0",
  mode: "chat",
  agents: [{ id: "claude", name: "Claude Code" }],
  agent: "claude",
};
const choosingCompanion: CompanionInfo = { ...chatCompanion, agent: undefined };
const terminalCompanion: CompanionInfo = { ...chatCompanion, mode: "mcp" };

function makeServices(): ConnectServices {
  return {
    loadPairing: vi.fn(),
    savePairing: vi.fn(),
    clearPairing: vi.fn(),
    roomUrl: (roomId) => `wss://run.test/api/connect/rooms/${roomId}?role=tab`,
    openSocket: () => ({ send: vi.fn(), close: vi.fn() }),
    executeTool: () => new Promise(() => {}),
    undoEdit: vi.fn(),
    openProject: () => ({ id: "p1", name: "Bank transfers", origin: "community" }),
    kdfIterations: 1_000,
  };
}

const connectMachine = createConnectMachine(makeServices());

const clearPairingOutcome: ActorOutcome<void> = { outputs: [undefined], error: new Error("The storage is blocked.") };
const pairingOutcomes = {
  loadPairing: { outputs: [undefined, unconfirmed, confirmed], error: new Error("The storage is blocked.") },
  createPairing: { outputs: [unconfirmed], error: new Error("The disk is full.") },
  confirmPairing: { outputs: [confirmed], error: new Error("The disk is full.") },
  clearPairing: clearPairingOutcome,
} satisfies Record<string, ActorOutcome<unknown>>;
const pairedOutcomes = {
  ...pairingOutcomes,
  loadPairing: { outputs: [confirmed] },
} satisfies Record<string, ActorOutcome<unknown>>;

function makeLinkClosed(code: number) {
  return { type: "link.closed", code, reason: "" } as const;
}

function makeGreeted(companion: CompanionInfo) {
  return { type: "companion.greeted", peer: COMPANION, companion } as const;
}

function makeChatSend(text: string) {
  return { type: "chat.message.send", conversation: CONVERSATION, text } as const;
}

function makeToolCall(name: "get_project" | "apply_edits" | "run") {
  return {
    type: "companion.message",
    peer: COMPANION,
    message: { type: "tool.call", id: CALL_ID, name, input: {} },
  } as const;
}

const request: ConnectToolRequest = { id: CALL_ID, call: { name: "get_project", input: {} }, mode: "ask" };

function makeToolSettled(peer: string, withEdit: boolean) {
  return {
    type: "tool.settled",
    request,
    peer,
    outcome: {
      ok: true,
      result: null,
      ...(withEdit
        ? {
            pendingEdit: {
              projectId: "p1",
              projectName: "Bank transfers",
              files: [{ path: "query.ts", after: "select 1;", added: 1, removed: 0 }],
            },
          }
        : {}),
    },
  } as const;
}

const closedRateLimited = makeLinkClosed(RELAY_CLOSE.rateLimited);
const closedExpired = makeLinkClosed(RELAY_CLOSE.expired);
const closedUnproven = makeLinkClosed(RELAY_CLOSE.unproven);
const closedDropped = makeLinkClosed(1006);
const greetedChat = makeGreeted(chatCompanion);
const greetedChoosing = makeGreeted(choosingCompanion);
const greetedTerminal = makeGreeted(terminalCompanion);
const chooseClaude = { type: "chat.agent.choose", agent: "claude" } as const;
const chooseCodex = { type: "chat.agent.choose", agent: "codex" } as const;
const sendHi = makeChatSend("Hi");
const sendBlank = makeChatSend("  ");
const sendTooLong = makeChatSend("a".repeat(CONNECT_LIMITS.maxChatChars + 1));
const allowEditsInChat = { type: "chat.mode.set", mode: "edit", conversation: CONVERSATION } as const;
const allowEdits = { type: "chat.mode.set", mode: "edit" } as const;
const askOnly = { type: "chat.mode.set", mode: "ask" } as const;
const callGetProject = makeToolCall("get_project");
const callApplyEdits = makeToolCall("apply_edits");
const callRun = makeToolCall("run");
const callUnknown = {
  type: "companion.message",
  peer: COMPANION,
  message: { type: "tool.unknown", id: CALL_ID, name: "bash" },
} as const;
const forgotten = { type: "companion.message", peer: COMPANION, message: { type: "forgotten" } } as const;
const agentChosen = {
  type: "companion.message",
  peer: COMPANION,
  message: { type: "agent.chosen", agent: "claude" },
} as const;
const settledWithEdit = makeToolSettled(COMPANION, true);
const settledWithoutEdit = makeToolSettled(COMPANION, false);
const settledForOtherCompanion = makeToolSettled(OTHER_COMPANION, false);
const undoSettled = { type: "undo.settled", id: EDIT_ID } as const;
const undoFailed = { type: "undo.settled", id: EDIT_ID, error: "The file changed." } as const;
const eventLabels = new Map<unknown, string>([
  [closedRateLimited, "link.closed rate limited"],
  [closedExpired, "link.closed expired"],
  [closedUnproven, "link.closed unproven"],
  [closedDropped, "link.closed dropped"],
  [greetedChat, "companion.greeted with an agent"],
  [greetedChoosing, "companion.greeted without an agent"],
  [greetedTerminal, "companion.greeted in a terminal"],
  [chooseClaude, "chat.agent.choose Claude Code"],
  [chooseCodex, "chat.agent.choose Codex, not offered"],
  [sendHi, "chat.message.send"],
  [sendBlank, "chat.message.send blank"],
  [sendTooLong, "chat.message.send too long"],
  [allowEditsInChat, "chat.mode.set edit in the chat"],
  [allowEdits, "chat.mode.set edit"],
  [askOnly, "chat.mode.set ask"],
  [callGetProject, "companion.message tool.call get_project"],
  [callApplyEdits, "companion.message tool.call apply_edits"],
  [callRun, "companion.message tool.call run"],
  [callUnknown, "companion.message tool.unknown"],
  [forgotten, "companion.message forgotten"],
  [agentChosen, "companion.message agent.chosen"],
  [settledWithEdit, "tool.settled with an edit"],
  [settledWithoutEdit, "tool.settled"],
  [settledForOtherCompanion, "tool.settled for another companion"],
  [undoSettled, "undo.settled"],
  [undoFailed, "undo.settled failed"],
]);
const outputLabels = new Map<unknown, string>([
  [unconfirmed, "an unconfirmed pairing"],
  [confirmed, "a confirmed pairing"],
]);

function describeEvent(event: ModelEvent) {
  const settled = /^xstate\.done\.actor\.0\.connect\.(?:\w+\.)*(\w+)$/.exec(event.type);

  if (settled !== null && settled[1] === "loading" && event.output === undefined) {
    return "done(loading) without a pairing";
  }

  if (settled !== null && outputLabels.has(event.output)) {
    return `done(${settled[1]}) with ${outputLabels.get(event.output)}`;
  }

  return eventLabels.get(event);
}

type ConnectSnapshot = SnapshotFrom<typeof connectMachine>;

const delayedStates = [
  { state: "reconnecting", event: { type: "xstate.after.backoff.connect.reconnecting" } },
  { state: "limited", event: { type: "xstate.after.backoff.connect.limited" } },
  { state: { linked: "busy" }, event: { type: "xstate.after.untilRetry.connect.linked.busy" } },
  { state: { linked: "notifyingForget" }, event: { type: "xstate.after.forgetWait.connect.linked.notifyingForget" } },
] as const;

function getDelayEvents(snapshot: ConnectSnapshot): ModelEvent[] {
  return delayedStates.filter(({ state }) => snapshot.matches(state)).map(({ event }) => event);
}

function isBeforePairing(snapshot: ConnectSnapshot) {
  return snapshot.matches("loading") || snapshot.matches({ unpaired: "fresh" });
}

function toPairingKind(pairing: ConnectPairing | undefined) {
  if (pairing === undefined) {
    return "none";
  }

  return pairing.confirmedAt === undefined ? "unconfirmed" : "confirmed";
}

function toCompanionKind(companion: CompanionInfo | undefined) {
  if (companion === undefined) {
    return "none";
  }

  if (companion.mode === "mcp") {
    return "terminal";
  }

  return companion.agent === undefined ? "choosing" : "ready";
}

function toPairingModel(snapshot: ConnectSnapshot) {
  const { pairing, dock } = snapshot.context;

  return {
    value: snapshot.value,
    pairing: toPairingKind(pairing),
    ...(isBeforePairing(snapshot) ? { dock } : {}),
  };
}

function toLinkModel(snapshot: ConnectSnapshot) {
  return { value: snapshot.value, companion: toCompanionKind(snapshot.context.companion) };
}

function toChatModel(snapshot: ConnectSnapshot) {
  const { companion, chats } = snapshot.context;

  return { value: snapshot.value, companion: toCompanionKind(companion), chats: Object.keys(chats).length };
}

function toToolCallModel(snapshot: ConnectSnapshot) {
  return { value: snapshot.value, linked: snapshot.context.peer !== undefined, mode: snapshot.context.mode };
}

function toEditModel(snapshot: ConnectSnapshot) {
  const { pendingEdits, queuedUndos, runningUndo } = snapshot.context;

  return {
    value: snapshot.value,
    edits: pendingEdits.length,
    queuedUndos: queuedUndos.length,
    undoing: runningUndo !== undefined,
  };
}

function toRunModel(snapshot: ConnectSnapshot) {
  const { peer, pendingRuns } = snapshot.context;

  return { value: snapshot.value, linked: peer !== undefined, runs: pendingRuns.length };
}

const walks = [
  {
    label: "pairing",
    toModelState: toPairingModel,
    events: (snapshot: ConnectSnapshot) => [
      ...(isBeforePairing(snapshot) ? [{ type: "dock.open" }, { type: "dock.close" }] : []),
      { type: "pairing.create" },
      { type: "pairing.forget" },
      { type: "link.opened" },
      greetedChat,
      ...getSettleEvents(snapshot, pairingOutcomes),
    ],
  },
  {
    label: "the link and the companion",
    toModelState: toLinkModel,
    events: (snapshot: ConnectSnapshot) => [
      { type: "pairing.forget" },
      { type: "link.retry" },
      { type: "link.disconnect" },
      { type: "tab.activate" },
      { type: "link.opened" },
      closedRateLimited,
      closedExpired,
      closedUnproven,
      closedDropped,
      greetedChat,
      { type: "companion.left" },
      { type: "companion.incompatible", range: { min: 2, max: 2 } },
      { type: "relay.busy", busy: { t: "busy", scope: "room", retryAt: "2000-01-01T00:00:00.000Z" } },
      forgotten,
      ...getDelayEvents(snapshot),
      ...getSettleEvents(snapshot, pairedOutcomes),
    ],
  },
  {
    label: "chats",
    toModelState: toChatModel,
    events: (snapshot: ConnectSnapshot) => [
      { type: "link.opened" },
      greetedChat,
      greetedChoosing,
      greetedTerminal,
      chooseClaude,
      chooseCodex,
      agentChosen,
      sendHi,
      sendBlank,
      sendTooLong,
      { type: "chat.turn.stop", conversation: CONVERSATION },
      allowEditsInChat,
      ...getSettleEvents(snapshot, pairedOutcomes),
    ],
  },
  {
    label: "tool calls",
    toModelState: toToolCallModel,
    events: (snapshot: ConnectSnapshot) => [
      { type: "link.opened" },
      greetedChat,
      allowEdits,
      askOnly,
      callGetProject,
      callApplyEdits,
      callUnknown,
      settledWithoutEdit,
      settledForOtherCompanion,
      closedDropped,
      { type: "link.retry" },
      ...getSettleEvents(snapshot, pairedOutcomes),
    ],
  },
  {
    label: "edits waiting for Keep or Undo",
    toModelState: toEditModel,
    events: (snapshot: ConnectSnapshot) => [
      ...(snapshot.context.pendingEdits.length === 0 ? [settledWithEdit] : []),
      { type: "edit.keep", id: EDIT_ID },
      { type: "edit.undo", id: EDIT_ID },
      { type: "undo.started", id: EDIT_ID },
      undoSettled,
      undoFailed,
    ],
  },
  {
    label: "runs waiting for the user",
    toModelState: toRunModel,
    events: (snapshot: ConnectSnapshot) => [
      { type: "link.opened" },
      greetedChat,
      ...(snapshot.context.pendingRuns.length === 0 ? [callRun] : []),
      { type: "run.confirm", id: CALL_ID },
      { type: "run.decline", id: CALL_ID },
      { type: "view.changed" },
      { type: "companion.left" },
      closedDropped,
      ...getSettleEvents(snapshot, pairedOutcomes),
    ],
  },
];

function startConnect() {
  const settler = createActorSettler();
  const machine = createConnectMachine(makeServices()).provide({
    actors: {
      loadPairing: settler.fromOutcome(pairingOutcomes.loadPairing),
      createPairing: settler.fromOutcome(pairingOutcomes.createPairing),
      confirmPairing: settler.fromOutcome(pairingOutcomes.confirmPairing),
      clearPairing: settler.fromOutcome(pairingOutcomes.clearPairing),
      restoreEdits: fromPromise<readonly PendingEdit[]>(() => new Promise(() => {})),
    },
  });
  const actor = createActor(machine).start();

  actor.getSnapshot().children.jobs?.send({ type: "tool.run", request, peer: COMPANION });

  return { actor, settler };
}

async function advanceTimers(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("connect machine paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  for (const { label, toModelState, events } of walks) {
    const paths = getMachinePaths(connectMachine, { toModelState, describeEvent, events });

    describe(`${label} paths`, () => {
      it("should take the same transitions", () => {
        expect(toTransitionTable(paths)).toMatchSnapshot();
      });

      for (const path of paths) {
        it(`should take ${path.description}`, async () => {
          const { actor, settler } = startConnect();

          await expect(
            replayMachinePath(path, {
              actor,
              settler,
              toModelState,
              advance: () => advanceTimers(MAX_DELAY_MS),
              flush: () => advanceTimers(0),
            }),
          ).resolves.toBeUndefined();
          actor.stop();
        });
      }
    });
  }
});
