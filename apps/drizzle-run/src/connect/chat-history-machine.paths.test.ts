import {
  type ActorOutcome,
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import type { ConnectActivity } from "@drizzle-run/runtime/machines";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, type SnapshotFrom } from "xstate";

import { EMPTY_HISTORY, type ChatHistory } from "./chat-history";
import { createChatHistoryMachine, SAVE_DELAY_MS } from "./chat-history-machine";

const firstConversation = "project:p1";
const secondConversation = "project:p2";
const SAVE_DELAY_EVENT = { type: `xstate.after.${SAVE_DELAY_MS}.chatHistory.ready.scheduled` } as const;

const message: ConnectActivity = { kind: "user", id: "m1", conversation: firstConversation, text: "Hi", at: 1 };
const editHistory: ChatHistory = { ...EMPTY_HISTORY, mode: "edit" };
const loadOutcome: ActorOutcome<ChatHistory> = {
  outputs: [EMPTY_HISTORY, editHistory],
  error: new Error("The store is unavailable"),
};

function makeHistoryUpdate(label: string, update: (current: ChatHistory) => ChatHistory) {
  return Object.assign(update, { toJSON: () => label });
}

const openFirst = { type: "conversation.open", conversation: firstConversation } as const;
const openSecond = { type: "conversation.open", conversation: secondConversation } as const;
const clearEntries = { type: "entries.change", entries: [] } as const;
const addMessage = { type: "entries.change", entries: [message] } as const;
const switchToEdit = { type: "mode.set", mode: "edit" } as const;
const switchToAsk = { type: "mode.set", mode: "ask" } as const;
const answerTool = {
  type: "history.change",
  update: makeHistoryUpdate("an answer", (current) => ({ ...current, answers: { ...current.answers, t1: "allowed" } })),
} as const;
const eventLabels = new Map<unknown, string>([
  [openFirst, "conversation.open of the first chat"],
  [openSecond, "conversation.open of the second chat"],
  [clearEntries, "entries.change without rows"],
  [addMessage, "entries.change with a message"],
  [switchToEdit, "mode.set to Edit"],
  [switchToAsk, "mode.set to Ask"],
  [answerTool, "history.change with an answer"],
  [SAVE_DELAY_EVENT, `after ${SAVE_DELAY_MS} ms`],
]);

function describeEvent(event: { type: string; output?: unknown }) {
  if (event.output === EMPTY_HISTORY) {
    return "done(load) in Ask mode";
  }

  if (event.output === editHistory) {
    return "done(load) in Edit mode";
  }

  return eventLabels.get(event);
}

const chatHistoryMachine = createChatHistoryMachine({ load: vi.fn(), save: vi.fn(), applyMode: vi.fn() });

function toModelState(snapshot: SnapshotFrom<typeof chatHistoryMachine>) {
  const { conversation, history, entries, stored } = snapshot.context;

  return {
    value: snapshot.value,
    conversation: conversation === firstConversation ? "first" : "second",
    mode: history?.mode ?? "unloaded",
    entries: entries.length,
    stored,
  };
}

function startChatHistory() {
  const settler = createActorSettler();
  const save = vi.fn();
  const machine = createChatHistoryMachine({ load: vi.fn(), save, applyMode: vi.fn() }).provide({
    actors: { load: settler.fromOutcome(loadOutcome) },
  });

  return { actor: createActor(machine, { input: { conversation: firstConversation } }).start(), settler, save };
}

const paths = getMachinePaths(chatHistoryMachine, {
  input: { conversation: firstConversation },
  toModelState,
  describeEvent,
  events: (snapshot) => [
    openFirst,
    openSecond,
    clearEntries,
    addMessage,
    switchToEdit,
    switchToAsk,
    answerTool,
    { type: "history.flush" },
    ...(snapshot.matches({ ready: "scheduled" }) ? [SAVE_DELAY_EVENT] : []),
    ...getSettleEvents(snapshot, { load: loadOutcome }),
  ],
});

async function advanceTimers(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("chat history machine paths", () => {
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
      const { actor, settler } = startChatHistory();

      await expect(
        replayMachinePath(path, {
          actor,
          settler,
          toModelState,
          advance: () => advanceTimers(SAVE_DELAY_MS),
          flush: () => advanceTimers(0),
        }),
      ).resolves.toBeUndefined();
      actor.stop();
    });
  }
});
