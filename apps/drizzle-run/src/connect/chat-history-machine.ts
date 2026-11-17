import type { ConnectActivity } from "@drizzle-run/runtime/machines";
import { assign, fromPromise, setup } from "xstate";

import { declareType } from "../lib/declare-type";
import { EMPTY_HISTORY, type ChatHistory } from "./chat-history";

/** The longest a change waits before it is written, even while the agent keeps streaming. */
export const SAVE_DELAY_MS = 400;

/** What the chat history machine hears. */
export type ChatHistoryEvent =
  | { type: "conversation.open"; conversation: string }
  | { type: "entries.change"; entries: readonly ConnectActivity[] }
  | { type: "history.change"; update: (current: ChatHistory) => ChatHistory }
  | { type: "history.flush" };

interface ChatHistoryContext {
  conversation: string;
  /** The stored history with this tab's tuning; undefined until it loads. */
  history: ChatHistory | undefined;
  /** The stored rows merged with this tab's live ones. */
  entries: readonly ConnectActivity[];
  /** Whether the chat has a stored record to keep up to date: it loaded one, or saved one. */
  stored: boolean;
}

/** Where a chat's history is read and saved. */
export interface ChatHistoryDependencies {
  load: (conversation: string) => Promise<ChatHistory>;
  /** Merges the history into the stored one, keeping what another tab saved. */
  save: (conversation: string, history: ChatHistory) => void;
}

function hasContent(history: ChatHistory) {
  return history.entries.length > 0 || history.tuning !== undefined;
}

function isWorthSaving({ history, entries, stored }: ChatHistoryContext) {
  return history !== undefined && (stored || hasContent({ ...history, entries }));
}

/**
 * Create the chat history machine
 *
 * ```text
 * loading ─► ready.idle ─(change)─► ready.scheduled ─(SAVE_DELAY_MS, history.flush)─► ready.idle
 * any ─conversation.open─► loading (a scheduled save of the last chat runs first)
 * ```
 *
 * Changes wait at most `SAVE_DELAY_MS`, even while rows keep streaming, then save as a merge, so another tab's rows
 * stay. A chat with nothing said and no tuning is never written, unless it is already stored.
 * Changes before the history loaded are refused: they would write over it.
 */
export function createChatHistoryMachine({ load, save }: ChatHistoryDependencies) {
  return setup({
    types: {
      context: declareType<ChatHistoryContext>(),
      events: declareType<ChatHistoryEvent>(),
      input: declareType<{ conversation: string }>(),
    },
    actors: {
      load: fromPromise<ChatHistory, string>(({ input }) => load(input)),
    },
    guards: {
      hasContentWith: ({ context }, entries: readonly ConnectActivity[]) => isWorthSaving({ ...context, entries }),
      isOtherConversation: ({ context }, conversation: string) => context.conversation !== conversation,
    },
    actions: {
      save: ({ context }) => {
        if (context.history !== undefined && isWorthSaving(context)) {
          save(context.conversation, { ...context.history, entries: context.entries });
        }
      },
      markStored: assign({ stored: ({ context }) => isWorthSaving(context) }),
    },
  }).createMachine({
    id: "chatHistory",
    initial: "loading",
    context: ({ input }) => ({ conversation: input.conversation, history: undefined, entries: [], stored: false }),
    on: {
      "conversation.open": {
        guard: { type: "isOtherConversation", params: ({ event }) => event.conversation },
        target: ".loading",
        actions: assign({
          conversation: ({ event }) => event.conversation,
          history: undefined,
          entries: [],
          stored: false,
        }),
      },
    },
    states: {
      loading: {
        invoke: {
          src: "load",
          input: ({ context }) => context.conversation,
          onDone: {
            target: "ready",
            actions: assign({ history: ({ event }) => event.output, stored: ({ event }) => hasContent(event.output) }),
          },
          onError: { target: "ready", actions: assign({ history: EMPTY_HISTORY }) },
        },
      },
      ready: {
        initial: "idle",
        states: {
          idle: {
            on: {
              "entries.change": [
                {
                  guard: { type: "hasContentWith", params: ({ event }) => event.entries },
                  target: "scheduled",
                  actions: assign({ entries: ({ event }) => event.entries }),
                },
                { actions: assign({ entries: ({ event }) => event.entries }) },
              ],
              "history.change": {
                target: "scheduled",
                actions: assign({ history: ({ context, event }) => event.update(getHistory(context)) }),
              },
            },
          },
          scheduled: {
            after: { [SAVE_DELAY_MS]: { target: "idle", actions: ["save", "markStored"] } },
            on: {
              "entries.change": { actions: assign({ entries: ({ event }) => event.entries }) },
              "history.change": {
                actions: assign({ history: ({ context, event }) => event.update(getHistory(context)) }),
              },
              "history.flush": { target: "idle", actions: ["save", "markStored"] },
              "conversation.open": {
                guard: { type: "isOtherConversation", params: ({ event }) => event.conversation },
                target: "#chatHistory.loading",
                actions: [
                  "save",
                  assign({
                    conversation: ({ event }) => event.conversation,
                    history: undefined,
                    entries: [],
                    stored: false,
                  }),
                ],
              },
            },
          },
        },
      },
    },
  });
}

function getHistory(context: ChatHistoryContext): ChatHistory {
  if (context.history === undefined) {
    throw new Error(`Expected the history of chat '${context.conversation}' once it loaded, but got none.`);
  }

  return context.history;
}
