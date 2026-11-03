import { randomUUID } from "node:crypto";

import {
  AGENT_NAMES,
  type AgentId,
  type AgentTuning,
  type ConnectMessage,
  type ConnectToolScope,
} from "@drizzle-run/core/connect";
import {
  assign,
  fromCallback,
  fromPromise,
  sendTo,
  setup,
  stateIn,
  type ActorRefFrom,
  type SnapshotFrom,
} from "xstate";

import { AGENT_PLUGINS, type PreparedTurn, type UsableAgent } from "./agents/index.ts";
import { declareType } from "./declare-type.ts";
import type { RunningTurn, TurnEnd } from "./turn.ts";

/**
 * One chat of one tab: its agent session, and the turn it runs.
 * A chat runs one turn at a time: `idle`, then `preparing` while the plugin writes what the turn needs, `answering`
 * while the agent runs, and `cleaningUp` once it ended. A stop during `preparing` ends the turn before the agent starts.
 */

/** A message for a tab that is not a hello: the companion seals it once its turn in the outbox comes. */
export type Sealable = Exclude<ConnectMessage, { type: "hello" }>;

/** What became of a frame for a tab: sent, or why not. */
export type SendOutcome = "sent" | "too_large" | "not_ready" | "not_sent";

type ChatSend = Extract<ConnectMessage, { type: "chat.send" }>;

/** The longest text one `agent.text` frame carries, well under the relay's frame cap once sealed. */
export const TEXT_PIECE_CHARS = 60_000;

const MAX_TURN_ERROR_LENGTH = 2_000;

/** One turn the companion checked and hands to a chat. */
export interface TurnRequest {
  id: string;
  /** Names the turn in its tool calls. */
  token: string;
  tab: string;
  agent: AgentId;
  usableAgent: UsableAgent;
  tuning: AgentTuning;
  scope: ConnectToolScope;
  message: ChatSend;
}

/** What preparing a turn needs: the request, and where the chat's agent session stands. */
export interface TurnPreparation {
  turn: TurnRequest;
  first: boolean;
  session: string | undefined;
}

/** A prepared turn to run, with where its text and session go. */
export interface TurnLaunch {
  turn: TurnRequest;
  prepared: PreparedTurn;
  onText: (text: string) => void;
  onSession: (id: string) => void;
}

/** What a chat does through the companion. */
export interface ConversationServices {
  send(tab: string, message: Sealable): Promise<SendOutcome>;
  log(line: string): void;
  /** Writes what the turn needs and builds its command line. Rejects when the plugin cannot. */
  prepareTurn(preparation: TurnPreparation): Promise<PreparedTurn>;
  runTurn(launch: TurnLaunch): RunningTurn;
}

interface ConversationContext {
  id: string;
  tab: string;
  agent: AgentId | undefined;
  session: string | undefined;
  /** The next turn is the session's first: it gets the chat so far. */
  first: boolean;
  turn: TurnRequest | undefined;
  prepared: PreparedTurn | undefined;
  end: TurnEnd | undefined;
}

type ConversationEvent =
  | { type: "turn.start"; turn: TurnRequest }
  | { type: "turn.stop" }
  | { type: "agent.session"; id: string }
  | { type: "agent.ended"; end: TurnEnd };

const AGENT_TURN_ID = "agentTurn";

function toErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function toStartFailure(agent: AgentId, cause: unknown): TurnEnd {
  return { state: "failed", error: `${AGENT_NAMES[agent]} could not start: ${toErrorMessage(cause)}` };
}

function assertTurn(context: ConversationContext): TurnRequest {
  if (context.turn === undefined) {
    throw new Error(`Expected chat ${context.id} to have a turn`);
  }

  return context.turn;
}

function assertPrepared(context: ConversationContext): PreparedTurn {
  if (context.prepared === undefined) {
    throw new Error(`Expected chat ${context.id} to have a prepared turn`);
  }

  return context.prepared;
}

/**
 * Build a chat's machine
 *
 * The companion checks a message before it sends `turn.start`; the chat refuses it while a turn runs.
 */
export function createConversationMachine(services: ConversationServices) {
  return setup({
    types: {
      context: declareType<ConversationContext>(),
      events: declareType<ConversationEvent>(),
      input: declareType<{ id: string; tab: string }>(),
    },
    actors: {
      prepareTurn: fromPromise<PreparedTurn, TurnPreparation>(({ input }) => services.prepareTurn(input)),
      agentTurn: fromCallback<{ type: "turn.stop" }, { turn: TurnRequest; prepared: PreparedTurn }>(
        ({ input, sendBack, receive }) => {
          const { turn, prepared } = input;
          const running = services.runTurn({
            turn,
            prepared,
            onText: (text) => {
              for (let start = 0; start < text.length; start += TEXT_PIECE_CHARS) {
                void services.send(turn.tab, {
                  type: "agent.text",
                  conversation: turn.message.conversation,
                  turn: turn.id,
                  text: text.slice(start, start + TEXT_PIECE_CHARS),
                });
              }
            },
            onSession: (id) => sendBack({ type: "agent.session", id }),
          });

          receive(() => running.stop());
          running.done.then(
            (end) => sendBack({ type: "agent.ended", end }),
            (cause: unknown) => sendBack({ type: "agent.ended", end: toStartFailure(turn.agent, cause) }),
          );
        },
      ),
      cleanUpTurn: fromPromise<void, PreparedTurn>(async ({ input }) => {
        await input.cleanup?.();
      }),
    },
    guards: {
      isStopRequested: stateIn({ preparing: "stopRequested" }),
    },
    actions: {
      takeTurn: assign(({ context, event }) => {
        if (event.type !== "turn.start") {
          return {};
        }

        const { turn } = event;
        const isNewSession = context.agent !== turn.agent;
        const session = AGENT_PLUGINS[turn.agent].sessionNaming === "companion" ? randomUUID() : undefined;

        return {
          tab: turn.tab,
          turn,
          ...(isNewSession ? { agent: turn.agent, first: true, session } : {}),
        };
      }),
      refuseBusyTurn: ({ event }) => {
        if (event.type !== "turn.start") {
          return;
        }

        void services.send(event.turn.tab, {
          type: "agent.turn",
          conversation: event.turn.message.conversation,
          turn: event.turn.id,
          state: "failed",
          error: "The agent is still answering. Stop it or wait.",
        });
      },
      sayStarted: ({ context }) => {
        const turn = assertTurn(context);

        void services.send(turn.tab, {
          type: "agent.turn",
          conversation: turn.message.conversation,
          turn: turn.id,
          state: "started",
        });
        services.log(`${AGENT_NAMES[turn.agent]} is answering.`);
      },
      keepSession: assign({
        session: ({ context, event }) => (event.type === "agent.session" ? event.id : context.session),
      }),
      reportTurnEnd: ({ context }) => {
        const turn = assertTurn(context);
        const end = context.end ?? { state: "stopped" };

        void services.send(context.tab, {
          type: "agent.turn",
          conversation: turn.message.conversation,
          turn: turn.id,
          state: end.state,
          ...(end.state === "failed" ? { error: end.error.slice(0, MAX_TURN_ERROR_LENGTH) } : {}),
        });
        services.log(end.state === "failed" ? `The agent failed: ${end.error.split("\n")[0] ?? ""}` : "Answer done.");
      },
      settleSession: assign(({ context }) => {
        const naming = context.agent === undefined ? undefined : AGENT_PLUGINS[context.agent].sessionNaming;

        if (context.end?.state === "done" || (naming === "agent" && context.session !== undefined)) {
          return { first: false };
        }

        // The first turn may not have saved its session; the next one starts a fresh one.
        if (context.first && naming === "companion") {
          return { session: randomUUID() };
        }

        return {};
      }),
      clearTurn: assign({ turn: undefined, prepared: undefined, end: undefined }),
      logCleanupFailure: ({ event }) => {
        const error = "error" in event ? event.error : undefined;

        services.log(`Could not clean up after the turn: ${toErrorMessage(error)}`);
      },
    },
  }).createMachine({
    id: "conversation",
    initial: "idle",
    context: ({ input }) => ({
      id: input.id,
      tab: input.tab,
      agent: undefined,
      session: undefined,
      first: true,
      turn: undefined,
      prepared: undefined,
      end: undefined,
    }),
    on: {
      "turn.start": { actions: "refuseBusyTurn" },
    },
    states: {
      idle: {
        on: {
          "turn.start": { target: "preparing", actions: "takeTurn" },
        },
      },
      preparing: {
        invoke: {
          src: "prepareTurn",
          input: ({ context }) => ({ turn: assertTurn(context), first: context.first, session: context.session }),
          onDone: [
            {
              guard: "isStopRequested",
              target: "cleaningUp",
              actions: assign({ prepared: ({ event }) => event.output, end: { state: "stopped" } }),
            },
            {
              target: "answering",
              actions: [assign({ prepared: ({ event }) => event.output }), "sayStarted"],
            },
          ],
          onError: {
            target: "idle",
            actions: [
              assign({ end: ({ context, event }) => toStartFailure(assertTurn(context).agent, event.error) }),
              "settleSession",
              "reportTurnEnd",
              "clearTurn",
            ],
          },
        },
        initial: "working",
        states: {
          working: {
            on: { "turn.stop": "stopRequested" },
          },
          stopRequested: {},
        },
      },
      answering: {
        invoke: {
          id: AGENT_TURN_ID,
          src: "agentTurn",
          input: ({ context }) => ({ turn: assertTurn(context), prepared: assertPrepared(context) }),
          onError: {
            target: "cleaningUp",
            actions: assign({ end: ({ context, event }) => toStartFailure(assertTurn(context).agent, event.error) }),
          },
        },
        on: {
          "agent.session": { actions: "keepSession" },
          "agent.ended": { target: "cleaningUp", actions: assign({ end: ({ event }) => event.end }) },
        },
        initial: "streaming",
        states: {
          streaming: {
            on: {
              "turn.stop": { target: "stopping", actions: sendTo(AGENT_TURN_ID, { type: "turn.stop" }) },
            },
          },
          stopping: {},
        },
      },
      cleaningUp: {
        invoke: {
          src: "cleanUpTurn",
          input: ({ context }) => assertPrepared(context),
          onDone: { target: "idle", actions: ["settleSession", "reportTurnEnd", "clearTurn"] },
          onError: { target: "idle", actions: ["logCleanupFailure", "settleSession", "reportTurnEnd", "clearTurn"] },
        },
      },
    },
  });
}

/** A running chat. */
export type ConversationActor = ActorRefFrom<ReturnType<typeof createConversationMachine>>;

/** The turn a token names, while it may still call tools: from `preparing` until its agent ends. */
export function resolveLiveTurn(
  snapshot: SnapshotFrom<ReturnType<typeof createConversationMachine>>,
  token: string,
): TurnRequest | undefined {
  const { turn } = snapshot.context;
  const isLive = snapshot.matches({ preparing: "working" }) || snapshot.matches({ answering: "streaming" });

  return isLive && turn?.token === token ? turn : undefined;
}
