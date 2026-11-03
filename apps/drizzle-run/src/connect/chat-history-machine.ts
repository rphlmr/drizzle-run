import type { ChatMode } from "@drizzle-run/core/connect";
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
  | { type: "mode.set"; mode: ChatMode }
  | { type: "history.flush" };

interface ChatHistoryContext {
  conversation: string;
  /** The stored history with this tab's mode, answers and tuning; undefined until it loads. */
  history: ChatHistory | undefined;
  /** The stored rows merged with this tab's live ones. */
  entries: readonly ConnectActivity[];
  /** Whether the chat has a stored record to keep up to date: it loaded one, or saved one. */
  stored: boolean;
}

/** Where a chat's history is read and saved, and who hears the mode of the chat open now. */
export interface ChatHistoryDependencies {
  load: (conversation: string) => Promise<ChatHistory>;
  /** Merges the history into the stored one, keeping what another tab saved. */
  save: (conversation: string, history: ChatHistory) => void;
  /** Hears the chat's mode once its history loads, and each time it is set. */
  applyMode: (conversation: string, mode: ChatMode) => void;
}

function hasContent(history: ChatHistory) {
  return (
    history.entries.length > 0 ||
    history.mode !== "ask" ||
    Object.keys(history.answers).length > 0 ||
    history.tuning !== undefined
  );
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
 * stay. A chat with nothing said, in Ask mode, with no answer or tuning, is never written, unless it is already stored.
 * Changes before the history loaded are refused: they would write over it. The chat's mode is applied when its
 * history loads and when `mode.set` changes it, so the chat keeps the mode it was left in.
 */
export function createChatHistoryMachine({ load, save, applyMode }: ChatHistoryDependencies) {
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
      setMode: assign({ history: ({ context }, mode: ChatMode) => ({ ...getHistory(context), mode }) }),
      applyMode: ({ context }) => applyMode(context.conversation, getHistory(context).mode),
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
            actions: [
              assign({ history: ({ event }) => event.output, stored: ({ event }) => hasContent(event.output) }),
              "applyMode",
            ],
          },
          onError: { target: "ready", actions: [assign({ history: EMPTY_HISTORY }), "applyMode"] },
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
              "mode.set": {
                target: "scheduled",
                actions: [{ type: "setMode", params: ({ event }) => event.mode }, "applyMode"],
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
              "mode.set": { actions: [{ type: "setMode", params: ({ event }) => event.mode }, "applyMode"] },
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
