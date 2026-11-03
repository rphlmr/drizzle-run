import {
  AGENT_EFFORTS,
  AGENT_IDS,
  isConnectToolName,
  isToolErrorCode,
  type AgentEffort,
  type AgentId,
  type ChatContextEntry,
  type ChatMode,
  type ConnectToolName,
  type ToolErrorCode,
} from "@drizzle-run/core/connect";
import type { ConnectActivity } from "@drizzle-run/runtime/machines";
import * as z from "zod/mini";

/**
 * A chat's history, kept in this browser per conversation (`chat:<conversation>` in the
 * settings store, never synced): its messages and tool rows, its mode, its agent, model and
 * effort, and how the user answered each "This needs an edit" card. The connect machine holds
 * only this tab's activity, so a page shows the stored history merged with what arrived since.
 */

/** The agent, model and effort a chat runs on. */
export interface ChatTuning {
  agent: AgentId;
  model?: string;
  effort?: AgentEffort;
}

export interface ChatHistory {
  version: 1;
  entries: readonly ConnectActivity[];
  mode: ChatMode;
  /** "Allow edits in this chat" or "Not now", by the refused tool call's id. */
  answers: Readonly<Record<string, ChatAnswer>>;
  /** What the chat runs on, set by its first message or the user's pick. Without it, the last pick anywhere. */
  tuning?: ChatTuning;
}

/** How the user answered an Ask card. */
export type ChatAnswer = z.output<typeof ChatAnswerSchema>;

/** Rows a chat keeps; older ones fall off. */
export const HISTORY_LIMIT = 300;

/** A chat with no rows, in Ask mode. */
export const EMPTY_HISTORY: ChatHistory = { version: 1, entries: [], mode: "ask", answers: {} };

/** The setting key a chat's history is stored under. */
export function getHistorySetting(conversation: string) {
  return `chat:${conversation}`;
}

const ConnectToolNameSchema = z.custom<ConnectToolName>((value) => isConnectToolName(value));

const ToolErrorCodeSchema = z.custom<ToolErrorCode>((value) => typeof value === "string" && isToolErrorCode(value));

const UserEntrySchema = z.object({
  kind: z.literal("user"),
  id: z.string(),
  conversation: z.string(),
  text: z.string(),
  at: z.number(),
});

const TextEntrySchema = z.object({
  kind: z.literal("text"),
  conversation: z.string(),
  turn: z.string(),
  text: z.string(),
  at: z.number(),
});

const TurnEntrySchema = z.object({
  kind: z.literal("turn"),
  conversation: z.string(),
  turn: z.string(),
  state: z.enum(["started", "done", "failed", "stopped"]),
  error: z.optional(z.string()),
  at: z.number(),
});

const ToolEntrySchema = z.object({
  kind: z.literal("tool"),
  id: z.string(),
  name: ConnectToolNameSchema,
  conversation: z.optional(z.string()),
  status: z.pipe(
    z.enum(["waiting", "running", "done", "failed", "refused"]),
    z.transform((status) => (status === "waiting" ? "refused" : status)),
  ),
  summary: z.optional(
    z.object({
      label: z.string(),
      target: z.optional(z.string()),
      meta: z.optional(z.string()),
      rolledBack: z.optional(z.literal(true)),
      createdProject: z.optional(z.object({ id: z.string(), name: z.string() })),
    }),
  ),
  error: z.optional(z.object({ code: ToolErrorCodeSchema, message: z.string() })),
  edit: z.optional(z.object({ id: z.string(), decision: z.enum(["pending", "kept", "undone"]) })),
  at: z.number(),
});

const EntrySchema = z.union([UserEntrySchema, TextEntrySchema, TurnEntrySchema, ToolEntrySchema]);

const ChatAnswerSchema = z.enum(["allowed", "dismissed"]);

const ChatTuningSchema = z.object({
  agent: z.enum(AGENT_IDS),
  model: z.optional(z.string()),
  effort: z.optional(z.enum(AGENT_EFFORTS)),
}) satisfies z.ZodMiniType<ChatTuning>;

const ChatHistorySchema = z.object({
  version: z.literal(1),
  entries: z.array(EntrySchema),
  mode: z.enum(["ask", "edit"]),
  answers: z.record(z.string(), ChatAnswerSchema),
  tuning: z.optional(ChatTuningSchema),
});

/** A stored history, or undefined when there is none or it does not read. */
export function readHistory(value: unknown): ChatHistory | undefined {
  const parsed = ChatHistorySchema.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}

/**
 * The same row in the store and in the machine. Streamed text merges into its turn's entry
 * and keeps the first chunk's time; a turn's text after a tool row is a second entry.
 */
function getEntryKey(entry: ConnectActivity): string {
  switch (entry.kind) {
    case "user":
      return `u:${entry.id}`;
    case "text":
      return `t:${entry.turn}:${entry.at}`;
    case "turn":
      return `n:${entry.turn}:${entry.state}`;
    case "tool":
      return `x:${entry.id}`;
  }
}

/** Whether a row belongs to a chat. Tool rows of a terminal agent have no conversation. */
export function isInConversation(entry: ConnectActivity, conversation: string) {
  return entry.conversation === conversation;
}

/**
 * Stored rows, updated by the live rows they share a key with, then the live rows the store
 * did not have yet, in the order they arrived. Live text replaces stored text: it only grows.
 */
export function mergeHistory(
  stored: readonly ConnectActivity[],
  live: readonly ConnectActivity[],
  conversation: string,
): readonly ConnectActivity[] {
  const merged = [...stored];
  const positions = new Map(merged.map((entry, index) => [getEntryKey(entry), index]));

  for (const entry of live) {
    if (!isInConversation(entry, conversation)) {
      continue;
    }

    const key = getEntryKey(entry);
    const position = positions.get(key);

    if (position === undefined) {
      positions.set(key, merged.length);
      merged.push(entry);
    } else {
      merged[position] = entry;
    }
  }

  return merged.length > HISTORY_LIMIT ? merged.slice(-HISTORY_LIMIT) : merged;
}

/**
 * Merge a tab's chat history into the stored one
 *
 * Keeps the stored rows another tab saved, takes this tab's rows over the stored ones they share a key with, adds
 * this tab's answers to the stored ones, and takes this tab's mode and tuning.
 */
export function mergeStoredHistory(stored: unknown, history: ChatHistory, conversation: string): ChatHistory {
  const current = readHistory(stored) ?? EMPTY_HISTORY;

  return {
    ...history,
    entries: mergeHistory(current.entries, history.entries, conversation),
    answers: { ...current.answers, ...history.answers },
  };
}

/**
 * Get the chat so far, for an agent session that starts without it
 *
 * The user's messages and the agent's answers, without tool rows; a turn's text split by tool rows is one answer.
 * Keeps the latest whole entries that fit `maxChars` of text and `maxEntries`; a single latest entry longer than
 * `maxChars` keeps its end. Returns an empty list for a chat with nothing said yet.
 */
export function getChatContext(
  entries: readonly ConnectActivity[],
  { maxChars, maxEntries }: { maxChars: number; maxEntries: number },
): ChatContextEntry[] {
  const said: { from: ChatContextEntry["from"]; text: string; turn?: string }[] = [];

  for (const entry of entries) {
    const previous = said.at(-1);

    if (entry.kind === "user") {
      said.push({ from: "user", text: entry.text });
    } else if (entry.kind === "text" && entry.text.trim() !== "") {
      if (previous?.from === "agent" && previous.turn === entry.turn) {
        previous.text += `\n${entry.text}`;
      } else {
        said.push({ from: "agent", text: entry.text, turn: entry.turn });
      }
    }
  }

  const context: ChatContextEntry[] = [];
  let chars = 0;

  for (const entry of said.toReversed()) {
    if (context.length === maxEntries) {
      break;
    }

    if (chars + entry.text.length > maxChars) {
      if (context.length === 0) {
        context.push({ from: entry.from, text: entry.text.slice(-maxChars) });
      }

      break;
    }

    context.push({ from: entry.from, text: entry.text });
    chars += entry.text.length;
  }

  return context.toReversed();
}
