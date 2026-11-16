import type { ConnectActivity } from "@drizzle-run/runtime/machines";
import { useActorRef, useSelector } from "@xstate/react";
import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useState } from "react";

import type { ConnectSettingStore } from "../store/storage";
import {
  EMPTY_HISTORY,
  getHistorySetting,
  mergeHistory,
  readHistory,
  type ChatHistory,
  type ChatTuning,
} from "./chat-history";
import { createChatHistoryMachine } from "./chat-history-machine";

/** A chat's stored rows and tuning, as `useChatHistory` returns them. */
export interface ChatHistoryState {
  /** False until stored history loads. Until then, entries contain only this tab's live rows. */
  loaded: boolean;
  entries: readonly ConnectActivity[];
  /** The chat's own agent, model and effort, once its first message or a pick set them. */
  tuning: ChatTuning | undefined;
  setTuning(tuning: ChatTuning): void;
}

/** A conversation's stored rows merged with the machine's live ones, saved back as they change. */
export function useChatHistory({
  settings,
  conversation,
  live,
}: {
  settings: ConnectSettingStore;
  conversation: string;
  live: readonly ConnectActivity[];
}): ChatHistoryState {
  const load = useEffectEvent(
    async (opened: string) => readHistory(await settings.readSetting(getHistorySetting(opened))) ?? EMPTY_HISTORY,
  );
  const save = useEffectEvent((saved: string, history: ChatHistory) => {
    void settings.mergeChatHistory(saved, history).catch((cause: unknown) => {
      console.error(`Saving the chat history of ${saved} failed`, cause);
    });
  });
  const [chatHistoryMachine] = useState(() =>
    createChatHistoryMachine({
      load: (opened) => load(opened),
      save: (saved, history) => save(saved, history),
    }),
  );
  const actor = useActorRef(chatHistoryMachine, { input: { conversation } });
  const stored = useSelector(actor, (snapshot) =>
    snapshot.context.conversation === conversation ? snapshot.context.history : undefined,
  );
  const entries = useMemo(() => mergeHistory(stored?.entries ?? [], live, conversation), [stored, live, conversation]);

  useEffect(() => {
    actor.send({ type: "conversation.open", conversation });
  }, [actor, conversation]);

  useEffect(() => {
    actor.send({ type: "entries.change", entries });
  }, [actor, entries]);

  useEffect(() => {
    const flush = () => actor.send({ type: "history.flush" });

    window.addEventListener("pagehide", flush);

    return () => window.removeEventListener("pagehide", flush);
  }, [actor]);

  useLayoutEffect(() => () => actor.send({ type: "history.flush" }), [actor]);

  const change = (update: (current: ChatHistory) => ChatHistory) => actor.send({ type: "history.change", update });

  return {
    loaded: stored !== undefined,
    entries,
    tuning: stored?.tuning,
    setTuning: (tuning) => change((current) => ({ ...current, tuning })),
  };
}
