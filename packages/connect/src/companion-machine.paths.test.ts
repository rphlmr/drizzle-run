import type * as nodeCrypto from "node:crypto";

import { CONNECT_PROTOCOL, RELAY_CLOSE, type ConnectKeys } from "@drizzle-run/core/connect";
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
import { createActor, fromCallback, fromPromise, type SnapshotFrom } from "xstate";

import { NO_LOCKDOWN } from "./agents/index.ts";
import { createCompanionMachine, type CompanionServices } from "./companion-machine.ts";
import { createConversationMachine, type ConversationServices } from "./conversation.ts";

vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof nodeCrypto>();

  return { ...crypto, randomBytes: (size: number) => Buffer.alloc(size) };
});

const FORGET_ANSWER_DELAY_MS = 300;
const FORGET_ANSWER_EVENT = { type: "xstate.after.forgetAnswer.companion.forgetting.closingLink" } as const;
const CALL_ID = Buffer.alloc(9).toString("base64url");
const firstTab = "t1";
const strangerTab = "t2";

function makeConversationServices(): ConversationServices {
  return { send: vi.fn(async () => "sent" as const), log: vi.fn(), prepareTurn: vi.fn(), runTurn: vi.fn() };
}

function makeServices(): CompanionServices {
  return {
    mode: "chat",
    agents: [{ ok: true, agent: { id: "claude", name: "Claude Code" }, command: "claude", lockdown: NO_LOCKDOWN }],
    toolTimeoutMs: 60_000,
    send: vi.fn(async () => "sent" as const),
    dropFrames: vi.fn(),
    clearFrames: vi.fn(),
    forgetPeer: vi.fn(),
    closeRelay: vi.fn(),
    clearPairing: vi.fn(async () => {}),
    log: vi.fn(),
    exit: vi.fn(),
    conversation: makeConversationServices(),
    deriveKeys: vi.fn(async () => ({ roomId: "room", key: {} as CryptoKey, roomProof: "proof" })),
    joinRelay: vi.fn(),
  };
}

const companionMachine = createCompanionMachine(makeServices());
const forgetPairingOutcome: ActorOutcome<void> = {
  outputs: [undefined],
  error: new Error("The pairing file is read only."),
};
const deriveKeysOutcome: ActorOutcome<ConnectKeys> = {
  outputs: [{ roomId: "room", key: {} as CryptoKey, roomProof: "proof" }],
  error: new Error("The pairing secret is malformed."),
};
const outcomes = { deriveKeys: deriveKeysOutcome, forgetPairing: forgetPairingOutcome };
const startCompanionEvent = { type: "companion.start" } as const;

function makeChatSend(tab: string, agent?: "claude" | "codex") {
  return {
    type: "tab.chat.send",
    tab,
    message: {
      type: "chat.send",
      conversation: "project:p1",
      text: "Hi",
      mode: "ask",
      ...(agent === undefined ? {} : { agent }),
    },
  } as const;
}

const welcomeWithoutTabs = { type: "relay.welcome", tabs: [] } as const;
const welcomeWithTab = { type: "relay.welcome", tabs: [firstTab] } as const;
const closedReplaced = { type: "relay.closed", code: RELAY_CLOSE.replaced, retryInMs: undefined } as const;
const closedWillRetry = { type: "relay.closed", code: 1006, retryInMs: 1_000 } as const;
const closedForGood = { type: "relay.closed", code: RELAY_CLOSE.expired, retryInMs: undefined } as const;
const noPeerError = { type: "relay.error", code: "no_peer", message: "No such peer." } as const;
const otherRelayError = { type: "relay.error", code: "bad_frame", message: "Bad frame." } as const;
const joinFirstTab = { type: "tab.joined", tab: firstTab } as const;
const leaveFirstTab = { type: "tab.left", tab: firstTab } as const;
const helloShared = { type: "tab.hello", tab: firstTab, protocol: CONNECT_PROTOCOL, answerHello: true } as const;
const helloUnshared = { type: "tab.hello", tab: firstTab, protocol: { min: 99, max: 99 }, answerHello: true } as const;
const helloFromStranger = {
  type: "tab.hello",
  tab: strangerTab,
  protocol: CONNECT_PROTOCOL,
  answerHello: true,
} as const;
const activateFirstTab = { type: "tab.activated", tab: firstTab } as const;
const activateStranger = { type: "tab.activated", tab: strangerTab } as const;
const chooseClaude = { type: "tab.agent.choose", tab: firstTab, agent: "claude" } as const;
const chooseCodex = { type: "tab.agent.choose", tab: firstTab, agent: "codex" } as const;
const chooseClaudeFromStranger = { type: "tab.agent.choose", tab: strangerTab, agent: "claude" } as const;
const sendWithClaude = makeChatSend(firstTab, "claude");
const sendWithoutAgent = makeChatSend(firstTab);
const sendWithCodex = makeChatSend(firstTab, "codex");
const sendFromStranger = makeChatSend(strangerTab, "claude");
const stopChat = { type: "tab.chat.stop", tab: firstTab, conversation: "project:p1" } as const;
const stopChatFromStranger = { type: "tab.chat.stop", tab: strangerTab, conversation: "project:p1" } as const;
const toolCall = { type: "tool.call", token: undefined, name: "get_project", input: {}, resolve: vi.fn() } as const;
const callUnsent = { type: "tool.call.unsent", id: CALL_ID, outcome: "not_ready" } as const;
const callExpired = { type: "tool.call.expired", id: CALL_ID } as const;
const toolResult = {
  type: "tab.tool.result",
  tab: firstTab,
  message: { type: "tool.result", id: CALL_ID, ok: true, result: null },
} as const;
const toolResultFromStranger = { ...toolResult, tab: strangerTab } as const;
const forgetFromFirstTab = { type: "tab.forget", tab: firstTab } as const;
const forgetFromStranger = { type: "tab.forget", tab: strangerTab } as const;
const eventLabels = new Map<unknown, string>([
  [welcomeWithoutTabs, "relay.welcome without tabs"],
  [welcomeWithTab, "relay.welcome with a tab"],
  [closedReplaced, "relay.closed replaced"],
  [closedWillRetry, "relay.closed with a retry"],
  [closedForGood, "relay.closed for good"],
  [noPeerError, "relay.error no peer"],
  [otherRelayError, "relay.error bad frame"],
  [helloShared, "tab.hello"],
  [helloUnshared, "tab.hello on another protocol"],
  [helloFromStranger, "tab.hello from an unknown tab"],
  [activateFirstTab, "tab.activated"],
  [activateStranger, "tab.activated from an unknown tab"],
  [chooseClaude, "tab.agent.choose Claude Code"],
  [chooseCodex, "tab.agent.choose Codex, not set up"],
  [chooseClaudeFromStranger, "tab.agent.choose from an unknown tab"],
  [sendWithClaude, "tab.chat.send with Claude Code"],
  [sendWithoutAgent, "tab.chat.send without an agent"],
  [sendWithCodex, "tab.chat.send with Codex, not set up"],
  [sendFromStranger, "tab.chat.send from an unknown tab"],
  [stopChatFromStranger, "tab.chat.stop from an unknown tab"],
  [toolResultFromStranger, "tab.tool.result from another tab"],
  [forgetFromStranger, "tab.forget from an unknown tab"],
  [FORGET_ANSWER_EVENT, `after ${FORGET_ANSWER_DELAY_MS} ms`],
]);

type CompanionSnapshot = SnapshotFrom<typeof companionMachine>;

function toModelState(snapshot: CompanionSnapshot) {
  const { agent, tabs, activeTab, conversations, calls } = snapshot.context;

  return {
    value: snapshot.value,
    agent: agent ?? "none",
    tab: tabs.get(firstTab) ?? "none",
    active: activeTab !== undefined,
    chats: conversations.size,
    calls: calls.size,
  };
}

function getToolCallEvents(snapshot: CompanionSnapshot): ModelEvent[] {
  return snapshot.context.calls.size === 0 ? [toolCall] : [];
}

const walks = [
  {
    label: "the relay link and the tabs that join it",
    events: (snapshot: CompanionSnapshot) => [
      startCompanionEvent,
      ...getSettleEvents(snapshot, outcomes),
      welcomeWithoutTabs,
      welcomeWithTab,
      closedReplaced,
      closedWillRetry,
      closedForGood,
      { type: "relay.busy", retryAt: "2026-10-25T00:00:00.000Z" },
      noPeerError,
      otherRelayError,
      joinFirstTab,
      leaveFirstTab,
      helloShared,
      helloUnshared,
      helloFromStranger,
      { type: "companion.stop" },
    ],
  },
  {
    label: "the tab in front and the chosen agent",
    events: (snapshot: CompanionSnapshot) => [
      startCompanionEvent,
      ...getSettleEvents(snapshot, outcomes),
      welcomeWithTab,
      helloShared,
      activateFirstTab,
      activateStranger,
      chooseClaude,
      chooseCodex,
      chooseClaudeFromStranger,
      leaveFirstTab,
      joinFirstTab,
    ],
  },
  {
    label: "chats",
    events: (snapshot: CompanionSnapshot) => [
      startCompanionEvent,
      ...getSettleEvents(snapshot, outcomes),
      welcomeWithTab,
      helloShared,
      sendWithClaude,
      sendWithoutAgent,
      sendWithCodex,
      sendFromStranger,
      stopChat,
      stopChatFromStranger,
      leaveFirstTab,
    ],
  },
  {
    label: "tool calls",
    events: (snapshot: CompanionSnapshot) => [
      startCompanionEvent,
      ...getSettleEvents(snapshot, outcomes),
      welcomeWithTab,
      helloShared,
      ...getToolCallEvents(snapshot),
      callUnsent,
      callExpired,
      toolResult,
      toolResultFromStranger,
      leaveFirstTab,
      closedWillRetry,
      { type: "companion.stop" },
    ],
  },
  {
    label: "forgetting this computer",
    events: (snapshot: CompanionSnapshot) => [
      startCompanionEvent,
      welcomeWithTab,
      helloShared,
      forgetFromFirstTab,
      forgetFromStranger,
      ...getToolCallEvents(snapshot),
      closedWillRetry,
      ...(snapshot.matches({ forgetting: "closingLink" }) ? [FORGET_ANSWER_EVENT] : []),
      ...getSettleEvents(snapshot, outcomes),
    ],
  },
];

function startCompanion() {
  const settler = createActorSettler();
  const services = makeServices();
  const idleConversation = createConversationMachine(services.conversation).provide({
    actors: {
      prepareTurn: fromPromise(() => new Promise(() => {})),
      agentTurn: fromCallback(() => {}),
      cleanUpTurn: fromPromise(async () => {}),
    },
  });
  const machine = createCompanionMachine(services).provide({
    actors: {
      conversation: idleConversation,
      toolCall: fromCallback(() => {}),
      deriveKeys: settler.fromOutcome(outcomes.deriveKeys),
      forgetPairing: settler.fromOutcome(outcomes.forgetPairing),
    },
  });

  return { actor: createActor(machine, { input: { agent: undefined } }).start(), settler };
}

async function advanceTimers(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("companion machine paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  for (const { label, events } of walks) {
    const paths = getMachinePaths(companionMachine, {
      input: { agent: undefined },
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
          const { actor, settler } = startCompanion();

          await expect(
            replayMachinePath(path, {
              actor,
              settler,
              toModelState,
              advance: () => advanceTimers(FORGET_ANSWER_DELAY_MS),
              flush: () => advanceTimers(0),
            }),
          ).resolves.toBeUndefined();
          actor.stop();
        });
      }
    });
  }
});
