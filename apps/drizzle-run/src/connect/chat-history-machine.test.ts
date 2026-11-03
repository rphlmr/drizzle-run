import type { ChatMode } from "@drizzle-run/core/connect";
import type { ConnectActivity } from "@drizzle-run/runtime/machines";
import { describe, expect, it } from "vitest";
import { createActor, SimulatedClock, waitFor } from "xstate";

import { createMemoryStore } from "../../test/store/memory-store";
import { LocalProjectStorage, VolatileProjectStorage, type ConnectSettingStore } from "../store/storage";
import { EMPTY_HISTORY, getHistorySetting, readHistory, type ChatHistory } from "./chat-history";
import { createChatHistoryMachine, SAVE_DELAY_MS } from "./chat-history-machine";

const conversation = "project:p1";

function makeMessage(id: string, chat = conversation): ConnectActivity {
  return { kind: "user", id, conversation: chat, text: id, at: 1 };
}

function startHistory(store: ConnectSettingStore, opened = conversation) {
  const clock = new SimulatedClock();
  const saves: { conversation: string; history: ChatHistory }[] = [];
  const appliedModes: { conversation: string; mode: ChatMode }[] = [];
  const actor = createActor(
    createChatHistoryMachine({
      load: async (chat) => readHistory(await store.readSetting(getHistorySetting(chat))) ?? EMPTY_HISTORY,
      save: (chat, history) => {
        saves.push({ conversation: chat, history });
        void store.mergeChatHistory(chat, history);
      },
      applyMode: (chat, mode) => appliedModes.push({ conversation: chat, mode }),
    }),
    { input: { conversation: opened }, clock },
  ).start();

  return { actor, clock, saves, appliedModes };
}

async function readStoredIds(store: ConnectSettingStore, chat = conversation) {
  const stored = readHistory(await store.readSetting(getHistorySetting(chat)));

  return stored?.entries.map((entry) => (entry.kind === "user" ? entry.id : entry.kind));
}

describe("createChatHistoryMachine", () => {
  it("should keep both tabs' rows when two tabs save the same chat", async () => {
    const memory = await createMemoryStore();
    const [firstStore, secondStore] = [
      new LocalProjectStorage({ client: memory.client }),
      new LocalProjectStorage({ client: memory.client }),
    ];
    const first = startHistory(firstStore);
    const second = startHistory(secondStore);
    await waitFor(first.actor, (snapshot) => snapshot.matches("ready"));
    await waitFor(second.actor, (snapshot) => snapshot.matches("ready"));

    first.actor.send({ type: "entries.change", entries: [makeMessage("first")] });
    second.actor.send({ type: "entries.change", entries: [makeMessage("second")] });
    first.actor.send({ type: "history.flush" });
    second.actor.send({ type: "history.flush" });

    await expect.poll(() => readStoredIds(firstStore)).toEqual(["first", "second"]);
  });

  it("should save at most once per delay while rows keep streaming", async () => {
    const { actor, clock, saves } = startHistory(new VolatileProjectStorage());
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));

    actor.send({ type: "entries.change", entries: [makeMessage("a")] });
    clock.increment(SAVE_DELAY_MS / 2);
    actor.send({ type: "entries.change", entries: [makeMessage("a"), makeMessage("b")] });
    clock.increment(SAVE_DELAY_MS / 2);

    expect(saves.map(({ history }) => history.entries.length)).toEqual([2]);
  });

  it("should refuse a change before the history loads, and never write an empty Ask chat", async () => {
    const store = new VolatileProjectStorage();
    const { actor, clock, saves } = startHistory(store);

    actor.send({ type: "mode.set", mode: "edit" });
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));
    actor.send({ type: "entries.change", entries: [] });
    clock.increment(SAVE_DELAY_MS);

    expect(actor.getSnapshot().context.history?.mode).toBe("ask");
    expect(saves).toEqual([]);
  });

  it("should save the switch back to Ask mode of a stored chat with nothing said", async () => {
    const store = new VolatileProjectStorage();
    await store.mergeChatHistory(conversation, { ...EMPTY_HISTORY, mode: "edit" });
    const { actor, saves } = startHistory(store);
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));

    actor.send({ type: "mode.set", mode: "ask" });
    actor.send({ type: "history.flush" });

    expect(saves).toEqual([{ conversation, history: EMPTY_HISTORY }]);
  });

  it("should save the switch back to Ask mode of a chat it saved in Edit mode", async () => {
    const { actor, saves } = startHistory(new VolatileProjectStorage());
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));

    actor.send({ type: "mode.set", mode: "edit" });
    actor.send({ type: "history.flush" });
    actor.send({ type: "mode.set", mode: "ask" });
    actor.send({ type: "history.flush" });

    expect(saves.map(({ history }) => history.mode)).toEqual(["edit", "ask"]);
  });

  it("should apply each chat's stored mode once it loads, then each mode set in it", async () => {
    const store = new VolatileProjectStorage();
    await store.mergeChatHistory("project:p2", { ...EMPTY_HISTORY, mode: "edit" });
    const { actor, appliedModes } = startHistory(store);

    actor.send({ type: "mode.set", mode: "edit" });
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));
    actor.send({ type: "mode.set", mode: "edit" });
    actor.send({ type: "conversation.open", conversation: "project:p2" });
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));

    expect(appliedModes).toEqual([
      { conversation, mode: "ask" },
      { conversation, mode: "edit" },
      { conversation: "project:p2", mode: "edit" },
    ]);
  });

  it("should save the last chat's waiting change before it opens another", async () => {
    const store = new VolatileProjectStorage();
    const { actor, saves } = startHistory(store);
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));

    actor.send({ type: "mode.set", mode: "edit" });
    actor.send({ type: "conversation.open", conversation: "project:p2" });

    expect(saves).toEqual([{ conversation, history: { ...EMPTY_HISTORY, mode: "edit" } }]);
    expect(actor.getSnapshot().context.conversation).toBe("project:p2");
  });
});
