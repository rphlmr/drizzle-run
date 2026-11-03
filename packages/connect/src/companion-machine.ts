import { randomBytes } from "node:crypto";

import {
  AGENT_NAMES,
  CONNECT_PROTOCOL,
  isToolInScope,
  RELAY_CLOSE,
  resolveAgentTuning,
  sharedProtocolVersion,
  type AgentId,
  type AgentTuning,
  type CompanionInfo,
  type ConnectKeys,
  type ConnectMessage,
  type ConnectToolName,
  type RelayErrorCode,
  type ToolError,
} from "@drizzle-run/core/connect";
import { assertEvent, assign, enqueueActions, fromCallback, fromPromise, not, setup, type EventObject } from "xstate";

import type { UsableAgent } from "./agents/index.ts";
import {
  createConversationMachine,
  resolveLiveTurn,
  type ConversationActor,
  type ConversationServices,
  type Sealable,
  type SendOutcome,
  type TurnRequest,
} from "./conversation.ts";
import { declareType } from "./declare-type.ts";
import type { ToolOutcome } from "./mcp-server.ts";

/**
 * The companion's decisions: its link to the relay, the tabs in the room, the chats, and the tool calls in flight.
 *
 * `idle` until `companion.start`, `starting` while it derives the room keys and until the relay first welcomes it, `linked` while its socket is up, `reconnecting` while the relay client
 * waits to retry, `forgetting` once a tab asked it to forget this computer, then `stopped`. Each tab is `joined` until
 * its hello shows a shared protocol, then `greeted`; one that left is gone from `tabs`. A tool call waits in `calls`
 * until its tab answers, the tab leaves, the link drops, or its time runs out.
 */

/** Why the companion asks its process to end. `relay_unreachable` is the only failure. */
export type CompanionExitReason = "forgotten" | "replaced" | "relay_closed" | "relay_unreachable";

/** A message the companion queues for a tab. A hello is sealed with the companion's latest info. */
export type OutgoingMessage = Sealable | { type: "hello" };

type HelloMessage = Extract<ConnectMessage, { type: "hello" }>;
type ChatSend = Extract<ConnectMessage, { type: "chat.send" }>;
type ToolResult = Extract<ConnectMessage, { type: "tool.result" }>;

/** How far a tab in the room got: `joined` until its hello, then `greeted`. */
type TabLink = "joined" | "greeted";

interface PendingCall {
  tab: string;
  conversation: string | undefined;
  resolve: (outcome: ToolOutcome) => void;
}

/** What the companion does through its process, its relay socket, and its outbox. */
export interface CompanionServices {
  mode: CompanionInfo["mode"];
  agents: readonly UsableAgent[];
  toolTimeoutMs: number;
  /** Queues a message for a tab; resolves once it is sent, or with why it was not. */
  send(tab: string, message: OutgoingMessage): Promise<SendOutcome>;
  /** Takes a tab's waiting frames out of the outbox. */
  dropFrames(tab: string, callIds?: ReadonlySet<string>): void;
  /** Takes every waiting frame out of the outbox. */
  clearFrames(): void;
  /** Forgets a tab's sealed session, so a tab that comes back greets again. */
  forgetPeer(tab: string): void;
  closeRelay(): void;
  /** Clears the pairing on this computer. */
  clearPairing(): Promise<void>;
  log(line: string): void;
  exit(reason: CompanionExitReason): void;
  conversation: ConversationServices;
  /** Derives the room, its key and its proof from the pairing secret. */
  deriveKeys(): Promise<ConnectKeys>;
  /** Opens the sealed channel and the relay socket for the room the keys name. */
  joinRelay(keys: ConnectKeys): void;
}

interface CompanionContext {
  agent: AgentId | undefined;
  tabs: ReadonlyMap<string, TabLink>;
  activeTab: string | undefined;
  conversations: ReadonlyMap<string, ConversationActor>;
  calls: ReadonlyMap<string, PendingCall>;
  /** Why the room keys could not be derived, once `starting` gave up. */
  startError: unknown;
}

/** What the companion's process, its relay socket, and its tabs tell it. */
export type CompanionEvent =
  | { type: "companion.start" }
  | { type: "relay.welcome"; tabs: readonly string[] }
  | { type: "relay.closed"; code: number; retryInMs: number | undefined }
  | { type: "relay.busy"; retryAt: string }
  | { type: "relay.error"; code: RelayErrorCode; message: string }
  | { type: "tab.joined"; tab: string }
  | { type: "tab.left"; tab: string }
  | { type: "tab.hello"; tab: string; protocol: HelloMessage["protocol"]; answerHello: boolean }
  | { type: "tab.forget"; tab: string }
  | { type: "tab.activated"; tab: string }
  | { type: "tab.agent.choose"; tab: string; agent: AgentId }
  | { type: "tab.chat.send"; tab: string; message: ChatSend }
  | { type: "tab.chat.stop"; tab: string; conversation: string }
  | { type: "tab.tool.result"; tab: string; message: ToolResult }
  | {
      type: "tool.call";
      /** The chat turn that made it; none for `--mcp`, whose calls go to the tab in front. */
      token: string | undefined;
      name: ConnectToolName;
      input: unknown;
      resolve: (outcome: ToolOutcome) => void;
    }
  | { type: "tool.call.unsent"; id: string; outcome: Exclude<SendOutcome, "sent"> }
  | { type: "tool.call.expired"; id: string }
  | { type: "companion.stop" };

type ToolCallEvent = Extract<CompanionEvent, { type: "tool.call" }>;
type ChatSendEvent = Extract<CompanionEvent, { type: "tab.chat.send" }>;

interface ToolCallInput {
  id: string;
  tab: string;
  message: Sealable;
}

/** Where a tool call goes, or why it goes nowhere. */
type CallTarget = { kind: "refused"; error: ToolError } | { kind: "tab"; tab: string; conversation?: string };

/** The agent a chat message runs on, or why it cannot run. */
type ChatTarget =
  | { kind: "refused"; error: string }
  | { kind: "ready"; agent: AgentId; usableAgent: UsableAgent; tuning: AgentTuning };

const FORGET_ANSWER_DELAY_MS = 300;

const STOPPED: ToolError = { code: "unavailable", message: "The companion stopped." };

const FORGOTTEN: ToolError = { code: "unavailable", message: "This computer forgot the pairing." };

const NO_TAB: ToolError = {
  code: "no_tab",
  message: "No Drizzle Run tab is connected. Open the project in the browser.",
};

/** The tool error for a call that did not reach its tab. */
function toUnsentCallError(outcome: Exclude<SendOutcome, "sent">): ToolError {
  switch (outcome) {
    case "too_large":
      return { code: "invalid_input", message: "This call is too large to send. Send fewer or smaller files." };
    case "not_ready":
      return { code: "no_tab", message: "The Drizzle Run tab is not ready." };
    case "not_sent":
      return { code: "unavailable", message: "The relay is not connected." };
  }
}

function createRandomId(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

/** Why the calls in flight end: the link dropped and will come back, the user forgot this computer, or it stops. */
function toRejectedCallError(event: CompanionEvent): ToolError {
  if (event.type === "relay.closed" && event.retryInMs !== undefined && event.code !== RELAY_CLOSE.replaced) {
    return toUnsentCallError("not_sent");
  }

  return event.type === "tab.forget" ? FORGOTTEN : STOPPED;
}

function toCallActorId(id: string): string {
  return `call:${id}`;
}

function countGreetedTabs(tabs: ReadonlyMap<string, TabLink>): number {
  return [...tabs.values()].filter((link) => link === "greeted").length;
}

function resolveCallTarget(context: CompanionContext, event: ToolCallEvent): CallTarget {
  if (event.token === undefined) {
    const firstGreeted = [...context.tabs].find(([, link]) => link === "greeted")?.[0];
    const tab = context.activeTab ?? firstGreeted;

    return tab === undefined || context.tabs.get(tab) !== "greeted"
      ? { kind: "refused", error: NO_TAB }
      : { kind: "tab", tab };
  }

  const turn = resolveTurnByToken(context, event.token);

  if (turn === undefined) {
    return { kind: "refused", error: { code: "unavailable", message: "This chat turn has ended." } };
  }

  // The tab refuses it too; this keeps a guided turn read only even if its MCP server were bypassed.
  if (!isToolInScope(event.name, turn.scope)) {
    return { kind: "refused", error: { code: "unavailable", message: `${event.name} is not available in this chat.` } };
  }

  return context.tabs.get(turn.tab) === "greeted"
    ? { kind: "tab", tab: turn.tab, conversation: turn.message.conversation }
    : { kind: "refused", error: NO_TAB };
}

function assertConversation(context: CompanionContext, id: string): ConversationActor {
  const conversation = context.conversations.get(id);

  if (conversation === undefined) {
    throw new Error(`Expected chat ${id} to be running`);
  }

  return conversation;
}

function resolveTurnByToken(context: CompanionContext, token: string): TurnRequest | undefined {
  for (const conversation of context.conversations.values()) {
    const turn = resolveLiveTurn(conversation.getSnapshot(), token);

    if (turn !== undefined) {
      return turn;
    }
  }

  return undefined;
}

function resolveChatTarget(context: CompanionContext, services: CompanionServices, message: ChatSend): ChatTarget {
  const agent = message.agent ?? context.agent;
  const usableAgent = services.agents.find((entry) => entry.agent.id === agent);

  if (services.mode !== "chat") {
    return { kind: "refused", error: "This companion serves a terminal agent (--mcp). Chat from that terminal." };
  }

  if (agent === undefined) {
    return { kind: "refused", error: "Choose an agent first." };
  }

  if (usableAgent === undefined) {
    return { kind: "refused", error: `${AGENT_NAMES[agent]} is not set up on this computer. Pick another agent.` };
  }

  const tuning = resolveAgentTuning(usableAgent.agent, { model: message.model, effort: message.effort });

  if (tuning === null) {
    const choice = [message.model, message.effort].filter(Boolean).join(" at ");

    return {
      kind: "refused",
      error: `${AGENT_NAMES[agent]} on this computer does not offer ${choice}. Pick another model or effort.`,
    };
  }

  return { kind: "ready", agent, usableAgent, tuning };
}

/** The log line for a closed relay socket. */
function toRelayClosedLine(code: number, retryInMs: number | undefined): string {
  if (retryInMs !== undefined) {
    const retry = `Retrying in ${Math.round(retryInMs / 1000)} s.`;

    return code === RELAY_CLOSE.rateLimited
      ? `The relay refused the connection: too many AI chat connections from your network. ${retry}`
      : `Disconnected from the relay. ${retry}`;
  }

  switch (code) {
    case RELAY_CLOSE.expired:
      return "The relay closed this pairing after a long idle time. Run the command again when you need it.";
    case RELAY_CLOSE.unproven:
      return "The relay refused this pairing code. Copy the command from the AI chat in Drizzle Run again, then run it.";
    case RELAY_CLOSE.misbehaving:
      return "The relay closed the connection. Run the command again to reconnect.";
    case RELAY_CLOSE.rateLimited:
      return "The relay kept refusing connections: too many AI chat connections from your network. Wait a minute, then run the command again.";
    default:
      return "Could not reach the relay after several tries. Check your network, then run the command again.";
  }
}

function isRoomEnded(code: number): boolean {
  return code === RELAY_CLOSE.expired || code === RELAY_CLOSE.misbehaving || code === RELAY_CLOSE.unproven;
}

/**
 * Build the companion's machine
 *
 * The companion's process turns relay frames into events, in the order they came, and reads `tabs` to drop frames
 * from peers it does not know. Every message to a tab goes through `services.send`.
 */
export function createCompanionMachine(services: CompanionServices) {
  return setup({
    types: {
      context: declareType<CompanionContext>(),
      events: declareType<CompanionEvent>(),
      input: declareType<{ agent: AgentId | undefined }>(),
    },
    actors: {
      conversation: createConversationMachine(services.conversation),
      toolCall: fromCallback<EventObject, ToolCallInput>(({ input, sendBack }) => {
        const timer = setTimeout(() => sendBack({ type: "tool.call.expired", id: input.id }), services.toolTimeoutMs);

        void services.send(input.tab, input.message).then((outcome) => {
          if (outcome !== "sent") {
            sendBack({ type: "tool.call.unsent", id: input.id, outcome });
          }
        });

        return () => clearTimeout(timer);
      }),
      deriveKeys: fromPromise<ConnectKeys>(() => services.deriveKeys()),
      forgetPairing: fromPromise<void, { tab: string }>(async ({ input }) => {
        await services.clearPairing();
        await services.send(input.tab, { type: "forgotten" });
      }),
    },
    delays: {
      forgetAnswer: FORGET_ANSWER_DELAY_MS,
    },
    guards: {
      isTabKnown: ({ context, event }) => "tab" in event && context.tabs.has(event.tab),
      isTabGreeted: ({ context, event }) => "tab" in event && context.tabs.get(event.tab) === "greeted",
      isProtocolShared: ({ event }) =>
        event.type === "tab.hello" && sharedProtocolVersion(CONNECT_PROTOCOL, event.protocol) !== undefined,
      isAgentOffered: ({ event }) =>
        event.type === "tab.agent.choose" &&
        services.mode === "chat" &&
        services.agents.some((entry) => entry.agent.id === event.agent),
      isChatRefused: ({ context, event }) =>
        event.type === "tab.chat.send" && resolveChatTarget(context, services, event.message).kind === "refused",
      isCallRefused: ({ context, event }) =>
        event.type === "tool.call" && resolveCallTarget(context, event).kind === "refused",
      isCallPending: ({ context, event }) => "id" in event && context.calls.has(event.id),
      isCallFromTab: ({ context, event }) =>
        event.type === "tab.tool.result" && context.calls.get(event.message.id)?.tab === event.tab,
      isReplaced: ({ event }) => event.type === "relay.closed" && event.code === RELAY_CLOSE.replaced,
      willRetry: ({ event }) => event.type === "relay.closed" && event.retryInMs !== undefined,
      isNoPeerError: ({ event }) => event.type === "relay.error" && event.code === "no_peer",
    },
    actions: {
      welcomeTabs: enqueueActions(({ enqueue, event }) => {
        assertEvent(event, "relay.welcome");
        enqueue.assign({ tabs: new Map(event.tabs.map((tab) => [tab, "joined"])), activeTab: undefined });
        enqueue(() => {
          services.log("Connected to the relay. Waiting for a Drizzle Run tab.");

          for (const tab of event.tabs) {
            void services.send(tab, { type: "hello" });
          }
        });
      }),
      joinTab: assign({
        tabs: ({ context, event }) => {
          assertEvent(event, "tab.joined");

          return new Map(context.tabs).set(event.tab, "joined");
        },
      }),
      sayHello: ({ event }) => {
        assertEvent(event, "tab.joined");
        void services.send(event.tab, { type: "hello" });
      },
      greetTab: enqueueActions(({ context, enqueue, event }) => {
        assertEvent(event, "tab.hello");

        if (context.tabs.get(event.tab) === "joined") {
          const tabs = new Map(context.tabs).set(event.tab, "greeted");

          enqueue.assign({ tabs });
          enqueue(() =>
            services.log(`Linked to a Drizzle Run tab (${countGreetedTabs(tabs)} open). New tabs join on their own.`),
          );
        }

        if (event.answerHello) {
          enqueue(() => void services.send(event.tab, { type: "hello" }));
        }
      }),
      leaveTab: enqueueActions(({ context, enqueue, event }) => {
        assertEvent(event, "tab.left");

        const tabs = new Map(context.tabs);

        tabs.delete(event.tab);
        enqueue(() => {
          services.forgetPeer(event.tab);
          services.dropFrames(event.tab);
        });

        // A tab that left never sees the answer, and its next message would find the turn still going.
        for (const conversation of context.conversations.values()) {
          if (conversation.getSnapshot().context.tab === event.tab) {
            enqueue.sendTo(conversation, { type: "turn.stop" });
          }
        }

        for (const [id, call] of context.calls) {
          if (call.tab === event.tab) {
            enqueue.stopChild(toCallActorId(id));
            enqueue(() =>
              call.resolve({ ok: false, error: { code: "no_tab", message: "The Drizzle Run tab closed." } }),
            );
          }
        }

        enqueue.assign({
          tabs,
          activeTab: context.activeTab === event.tab ? undefined : context.activeTab,
          calls: new Map([...context.calls].filter(([, call]) => call.tab !== event.tab)),
        });
        enqueue(() => services.log(countGreetedTabs(tabs) === 0 ? "No tab connected. Waiting." : "A tab left."));
      }),
      dropTabs: enqueueActions(({ context, enqueue }) => {
        // A tab may come back under the same peer id with its count started again, and it shows its turns ended.
        const tabs = [...context.tabs.keys()];

        enqueue(() => {
          for (const tab of tabs) {
            services.forgetPeer(tab);
          }

          services.clearFrames();
        });
        enqueue.assign({ tabs: new Map(), activeTab: undefined });
      }),
      stopTurns: enqueueActions(({ context, enqueue }) => {
        for (const conversation of context.conversations.values()) {
          enqueue.sendTo(conversation, { type: "turn.stop" });
        }
      }),
      rejectCalls: enqueueActions(({ context, enqueue, event }) => {
        const error = toRejectedCallError(event);

        for (const [id, call] of context.calls) {
          enqueue.stopChild(toCallActorId(id));
          enqueue(() => call.resolve({ ok: false, error }));
        }

        enqueue.assign({ calls: new Map() });
      }),
      closeLink: () => {
        services.clearFrames();
        services.closeRelay();
      },
      activateTab: assign({
        activeTab: ({ event }) => {
          assertEvent(event, "tab.activated");

          return event.tab;
        },
      }),
      chooseAgent: enqueueActions(({ context, enqueue, event }) => {
        assertEvent(event, "tab.agent.choose");
        const greetedTabs = [...context.tabs].filter(([, link]) => link === "greeted").map(([tab]) => tab);

        enqueue.assign({ agent: event.agent });
        enqueue(() => {
          services.log(`Chatting through ${AGENT_NAMES[event.agent]}.`);

          for (const tab of greetedTabs) {
            void services.send(tab, { type: "agent.chosen", agent: event.agent });
          }
        });
      }),
      refuseChat: ({ context, event }) => {
        assertEvent(event, "tab.chat.send");

        const target = resolveChatTarget(context, services, event.message);

        if (target.kind !== "refused") {
          return;
        }

        void services.send(event.tab, {
          type: "agent.turn",
          conversation: event.message.conversation,
          turn: createRandomId(9),
          state: "failed",
          error: target.error,
        });
      },
      startChat: enqueueActions(({ context, enqueue, event }) => {
        assertEvent(event, "tab.chat.send");

        const target = resolveChatTarget(context, services, event.message);

        if (target.kind !== "ready") {
          return;
        }

        const id = event.message.conversation;

        if (!context.conversations.has(id)) {
          enqueue.assign({
            conversations: ({ context: current, spawn }) =>
              new Map(current.conversations).set(id, spawn("conversation", { input: { id, tab: event.tab } })),
          });
        }

        enqueue.sendTo(({ context: current }) => assertConversation(current, id), {
          type: "turn.start",
          turn: toTurnRequest(event, target),
        });
      }),
      stopChat: enqueueActions(({ context, enqueue, event }) => {
        assertEvent(event, "tab.chat.stop");

        const conversation = context.conversations.get(event.conversation);

        if (conversation?.getSnapshot().context.tab === event.tab) {
          enqueue.sendTo(conversation, { type: "turn.stop" });
          const calls = new Map(context.calls);
          const cancelledIds = new Set<string>();

          for (const [id, call] of calls) {
            if (call.tab === event.tab && call.conversation === event.conversation) {
              cancelledIds.add(id);
              calls.delete(id);
              enqueue.stopChild(toCallActorId(id));
              enqueue(() => call.resolve({ ok: false, error: STOPPED }));
            }
          }

          enqueue.assign({ calls });
          enqueue(() => services.dropFrames(event.tab, cancelledIds));
        }
      }),
      refuseCall: ({ context, event }) => {
        assertEvent(event, "tool.call");

        const target = resolveCallTarget(context, event);

        if (target.kind === "refused") {
          event.resolve({ ok: false, error: target.error });
        }
      },
      forwardCall: enqueueActions(({ context, enqueue, event }) => {
        assertEvent(event, "tool.call");

        const target = resolveCallTarget(context, event);

        if (target.kind !== "tab") {
          return;
        }

        const id = createRandomId(9);
        const message: Sealable = {
          type: "tool.call",
          id,
          name: event.name,
          input: event.input,
          ...(target.conversation ? { conversation: target.conversation } : {}),
        };

        enqueue(() => services.log(`Tool ${event.name}`));
        enqueue.assign({
          calls: new Map(context.calls).set(id, {
            tab: target.tab,
            conversation: target.conversation,
            resolve: event.resolve,
          }),
        });
        enqueue.spawnChild("toolCall", { id: toCallActorId(id), input: { id, tab: target.tab, message } });
      }),
      answerCall: enqueueActions(({ context, enqueue, event }) => {
        assertEvent(event, "tab.tool.result");

        const { message } = event;
        const call = context.calls.get(message.id);

        enqueue(() =>
          call?.resolve(message.ok ? { ok: true, result: message.result } : { ok: false, error: message.error }),
        );
      }),
      failCall: ({ context, event }) => {
        assertEvent(event, ["tool.call.unsent", "tool.call.expired"]);

        const error: ToolError =
          event.type === "tool.call.unsent"
            ? toUnsentCallError(event.outcome)
            : { code: "timeout", message: "The Drizzle Run tab did not answer in time." };

        context.calls.get(event.id)?.resolve({ ok: false, error });
      },
      settleCall: enqueueActions(({ context, enqueue, event }) => {
        assertEvent(event, ["tab.tool.result", "tool.call.unsent", "tool.call.expired"]);

        const id = event.type === "tab.tool.result" ? event.message.id : event.id;
        const calls = new Map(context.calls);

        calls.delete(id);
        enqueue.stopChild(toCallActorId(id));
        enqueue.assign({ calls });
      }),
      logRelayClosed: ({ event }) => {
        assertEvent(event, "relay.closed");
        services.log(toRelayClosedLine(event.code, event.retryInMs));
      },
      exitAfterClose: ({ event }) => {
        assertEvent(event, "relay.closed");
        services.exit(isRoomEnded(event.code) ? "relay_closed" : "relay_unreachable");
      },
      logBusy: ({ event }) => {
        assertEvent(event, "relay.busy");
        services.log(`The chat is busy: the relay's daily limit is reached until ${event.retryAt}.`);
      },
      logRelayError: ({ event }) => {
        assertEvent(event, "relay.error");
        services.log(`Relay: ${event.message}`);
      },
    },
  }).createMachine({
    id: "companion",
    initial: "idle",
    context: ({ input }) => ({
      agent: input.agent,
      tabs: new Map(),
      activeTab: undefined,
      conversations: new Map(),
      calls: new Map(),
      startError: undefined,
    }),
    on: {
      "tool.call": [{ guard: "isCallRefused", actions: "refuseCall" }, { actions: "forwardCall" }],
      "tool.call.unsent": { guard: "isCallPending", actions: ["failCall", "settleCall"] },
      "tool.call.expired": { guard: "isCallPending", actions: ["failCall", "settleCall"] },
      "relay.closed": [
        {
          guard: "isReplaced",
          target: ".stopped",
          actions: [
            "dropTabs",
            "stopTurns",
            () => services.log("Another companion joined this pairing; this one stops."),
            "rejectCalls",
            "closeLink",
            () => services.exit("replaced"),
          ],
        },
        {
          guard: "willRetry",
          target: ".reconnecting",
          actions: ["dropTabs", "stopTurns", "rejectCalls", "logRelayClosed"],
        },
        {
          target: ".stopped",
          actions: ["dropTabs", "stopTurns", "logRelayClosed", "rejectCalls", "closeLink", "exitAfterClose"],
        },
      ],
      "relay.busy": { actions: "logBusy" },
      "relay.error": { guard: not("isNoPeerError"), actions: "logRelayError" },
      "companion.stop": {
        target: ".stopped",
        actions: ["stopTurns", "rejectCalls", "closeLink"],
      },
    },
    states: {
      idle: {
        on: {
          "companion.start": { target: "starting" },
        },
      },
      starting: {
        initial: "derivingKeys",
        states: {
          derivingKeys: {
            invoke: {
              src: "deriveKeys",
              onDone: {
                target: "joining",
                actions: ({ event }) => services.joinRelay(event.output),
              },
              onError: {
                target: "#companion.stopped",
                actions: assign({ startError: ({ event }) => event.error }),
              },
            },
          },
          joining: {
            on: {
              "relay.welcome": { target: "#companion.linked", actions: "welcomeTabs" },
            },
          },
        },
      },
      linked: {
        on: {
          "tab.joined": { actions: ["joinTab", "sayHello"] },
          "tab.left": { actions: "leaveTab" },
          "tab.hello": [
            { guard: not("isTabKnown") },
            { guard: "isProtocolShared", actions: "greetTab" },
            {
              actions: () =>
                services.log("A tab speaks another protocol version. Update with npx @drizzle-run/connect@latest."),
            },
          ],
          "tab.forget": {
            guard: "isTabGreeted",
            target: "forgetting",
            actions: ["stopTurns", "rejectCalls"],
          },
          "tab.activated": { guard: "isTabGreeted", actions: "activateTab" },
          "tab.agent.choose": { guard: "isTabGreeted", actions: "chooseAgent" },
          "tab.chat.send": [
            { guard: not("isTabGreeted") },
            { guard: "isChatRefused", actions: "refuseChat" },
            { actions: "startChat" },
          ],
          "tab.chat.stop": { guard: "isTabGreeted", actions: "stopChat" },
          "tab.tool.result": { guard: "isCallFromTab", actions: ["answerCall", "settleCall"] },
        },
      },
      reconnecting: {
        on: {
          "relay.welcome": { target: "linked", actions: "welcomeTabs" },
        },
      },
      forgetting: {
        on: {
          "tool.call": {
            actions: ({ event }) => refuseCallWith(event, FORGOTTEN),
          },
          "relay.closed": {},
        },
        initial: "clearingPairing",
        states: {
          clearingPairing: {
            invoke: {
              src: "forgetPairing",
              input: ({ event }) => {
                assertEvent(event, "tab.forget");

                return { tab: event.tab };
              },
              onDone: {
                target: "closingLink",
                actions: () => services.log("This computer forgot the pairing. Pair again from Drizzle Run."),
              },
              onError: {
                target: "#companion.linked",
                actions: () => services.log("Could not forget the pairing on this computer. Try Forget again."),
              },
            },
          },
          // Gives the relay a moment to forward the answer before the socket closes.
          closingLink: {
            after: {
              forgetAnswer: {
                target: "#companion.stopped",
                actions: ["stopTurns", "rejectCalls", "closeLink", () => services.exit("forgotten")],
              },
            },
          },
        },
      },
      stopped: {
        on: {
          "tool.call": {
            actions: ({ event }) => refuseCallWith(event, STOPPED),
          },
          "relay.closed": {},
          "companion.stop": {},
        },
      },
    },
  });
}

function refuseCallWith(event: CompanionEvent, error: ToolError): void {
  assertEvent(event, "tool.call");
  event.resolve({ ok: false, error });
}

function toTurnRequest(event: ChatSendEvent, target: Extract<ChatTarget, { kind: "ready" }>): TurnRequest {
  return {
    id: createRandomId(9),
    token: createRandomId(32),
    tab: event.tab,
    agent: target.agent,
    usableAgent: target.usableAgent,
    tuning: target.tuning,
    scope: event.message.scope ?? "project",
    message: event.message,
  };
}
