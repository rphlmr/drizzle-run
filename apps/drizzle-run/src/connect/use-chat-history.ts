import type { ChatMode } from "@drizzle-run/core/connect";
import type { ConnectActivity } from "@drizzle-run/runtime/machines";
import { useActorRef, useSelector } from "@xstate/react";
import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useState } from "react";

import type { ConnectSettingStore } from "../store/storage";
import {
  EMPTY_HISTORY,
  getHistorySetting,
  mergeHistory,
  readHistory,
  type ChatAnswer,
  type ChatHistory,
  type ChatTuning,
} from "./chat-history";
import { createChatHistoryMachine } from "./chat-history-machine";

/** A chat's stored rows, mode and answers, as `useChatHistory` returns them. */
export interface ChatHistoryState {
  /** False until stored history loads. Until then, entries contain only this tab's live rows. */
  loaded: boolean;
  entries: readonly ConnectActivity[];
  mode: ChatMode;
  answers: Readonly<Record<string, ChatAnswer>>;
  /** The chat's own agent, model and effort, once its first message or a pick set them. */
  tuning: ChatTuning | undefined;
  setMode(mode: ChatMode): void;
  answer(toolId: string, answer: ChatAnswer): void;
  setTuning(tuning: ChatTuning): void;
}

/**
 * A conversation's stored rows merged with the machine's live ones, saved back as they change
 *
 * `applyMode` hears the chat's mode once its history loads, and each time `setMode` changes it.
 */
export function useChatHistory({
  settings,
  conversation,
  live,
  applyMode,
}: {
  settings: ConnectSettingStore;
  conversation: string;
  live: readonly ConnectActivity[];
  applyMode: (conversation: string, mode: ChatMode) => void;
}): ChatHistoryState {
  const load = useEffectEvent(
    async (opened: string) => readHistory(await settings.readSetting(getHistorySetting(opened))) ?? EMPTY_HISTORY,
  );
  const save = useEffectEvent((saved: string, history: ChatHistory) => {
    void settings.mergeChatHistory(saved, history).catch((cause: unknown) => {
      console.error(`Saving the chat history of ${saved} failed`, cause);
    });
  });
  const applyChatMode = useEffectEvent((opened: string, mode: ChatMode) => applyMode(opened, mode));
  const [chatHistoryMachine] = useState(() =>
    createChatHistoryMachine({
      load: (opened) => load(opened),
      save: (saved, history) => save(saved, history),
      applyMode: (opened, mode) => applyChatMode(opened, mode),
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
    mode: stored?.mode ?? "ask",
    answers: stored?.answers ?? EMPTY_HISTORY.answers,
    tuning: stored?.tuning,
    setMode: (mode) => actor.send({ type: "mode.set", mode }),
    answer: (toolId, value) => change((current) => ({ ...current, answers: { ...current.answers, [toolId]: value } })),
    setTuning: (tuning) => change((current) => ({ ...current, tuning })),
  };
}
