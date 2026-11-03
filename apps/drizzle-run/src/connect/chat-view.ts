import { AGENT_NAMES, type ConnectToolName } from "@drizzle-run/core/connect";
import type { ConnectActivity, ConnectQuota, ConnectStatus } from "@drizzle-run/runtime/machines";

import type { ChatAnswer } from "./chat-history";

/**
 * Derive the chat panel from the connection status and conversation rows.
 * Shared by project and guide chats so both render the same states.
 */

export type ChatTone = "ok" | "warn" | "err" | "faint";

/** The chat header: the agent's name and its status. */
export interface ChatHead {
  name: string;
  status: string;
  tone: ChatTone;
}

/** "02:00": the hour the relay takes chats again, in the reader's time. */
export function retryTime(retryAt: string): string {
  const date = new Date(retryAt);

  return Number.isNaN(date.getTime())
    ? "a while"
    : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

/** The agent a status names: the chosen one, the terminal's, else the last one this page saw. */
export function getAgentName(status: ConnectStatus, last: string | undefined): string | undefined {
  if (status.kind === "ready") {
    return AGENT_NAMES[status.agent];
  }

  if (status.kind === "terminal") {
    return status.companion.agent ? AGENT_NAMES[status.companion.agent] : (last ?? "Terminal agent");
  }

  return status.kind === "disconnected" || status.kind === "busy" || status.kind === "off" || status.kind === "limited"
    ? last
    : undefined;
}

/** The chat header for the connection status. */
export function getChatHead(status: ConnectStatus, agent: string | undefined): ChatHead {
  switch (status.kind) {
    case "choosing":
      return { name: "AI chat", status: "Companion connected", tone: "ok" };
    case "ready":
      return { name: agent ?? "AI chat", status: "Connected · this project only", tone: "ok" };
    case "terminal":
      return { name: agent ?? "AI chat", status: "Connected from your terminal", tone: "ok" };
    case "disconnected":
      return { name: agent ?? "AI chat", status: "Companion stopped", tone: "err" };
    case "off":
      return { name: agent ?? "AI chat", status: "Disconnected", tone: "faint" };
    case "busy":
      return { name: agent ?? "AI chat", status: `Busy · try again after ${retryTime(status.retryAt)}`, tone: "warn" };
    case "limited":
      return { name: agent ?? "AI chat", status: "Too many connections · retrying", tone: "warn" };
    case "incompatible":
      return { name: "AI chat", status: "Update the companion", tone: "warn" };
    case "forgetting":
      return { name: "AI chat", status: "Forgetting this computer", tone: "faint" };
    case "loading":
    case "unpaired":
    case "pairing":
    case "waiting":
      return { name: "AI chat", status: "Not connected", tone: "faint" };
  }
}

/** The line under the composer that says how much of today's AI chat this tab's share has used. */
export interface QuotaLine {
  /** "38% of today's AI chat used", with the reset time once it is full. */
  text: string;
  /** "02:00": when the share starts again, in the reader's time. */
  resetTime: string;
  /** Whose share it is, in the explanation's words. */
  holder: "account" | "connection";
}

/**
 * The quota line for today's share, or undefined before the relay told it
 *
 * The percent rounds down, so it reads 100% only once the share is spent; a share with no limit reads full.
 */
export function getQuotaLine(quota: ConnectQuota | undefined): QuotaLine | undefined {
  if (quota === undefined) {
    return undefined;
  }

  const full = quota.used >= quota.limit;
  const percent = full ? 100 : Math.floor((quota.used * 100) / quota.limit);
  const resetTime = retryTime(quota.resetAt);

  return {
    text: full ? `100% of today's AI chat used · resets at ${resetTime}` : `${percent}% of today's AI chat used`,
    resetTime,
    holder: quota.per ?? "connection",
  };
}

/** What the chat panel shows: setup, pairing, the chat itself, or a status. */
export type ChatBody =
  | "loading"
  | "setup"
  | "pair"
  | "return"
  | "off"
  | "empty"
  | "messages"
  | "incompatible"
  | "forgetting";

/** The panel's body for this status; a chat that has rows keeps showing them while the companion is away. */
export function getChatBody(status: ConnectStatus, hasRows: boolean): ChatBody {
  switch (status.kind) {
    case "loading":
      return "loading";
    case "unpaired":
    case "pairing":
      return "setup";
    case "waiting":
      return "return";
    case "choosing":
      return "pair";
    case "ready":
      return hasRows ? "messages" : "empty";
    case "terminal":
    case "busy":
    case "limited":
      return "messages";
    case "disconnected":
      return hasRows ? "messages" : "return";
    case "off":
      return hasRows ? "messages" : "off";
    case "incompatible":
      return "incompatible";
    case "forgetting":
      return "forgetting";
  }
}

/** The composer's placeholder, and whether it is off. */
export interface ChatComposer {
  placeholder: string;
  disabled: boolean;
}

/** The chat composer, or undefined during setup, pairing and terminal mode. */
export function getChatComposer(
  status: ConnectStatus,
  working: boolean,
  agent: string | undefined,
  idle: string,
): ChatComposer | undefined {
  switch (status.kind) {
    case "ready":
      return { placeholder: working ? `${agent ?? "The agent"} is working` : idle, disabled: false };
    case "disconnected":
    case "off":
      return { placeholder: "Not connected", disabled: true };
    case "busy":
      return { placeholder: "AI chat is busy", disabled: true };
    case "limited":
      return { placeholder: "Reconnecting", disabled: true };
    case "loading":
    case "unpaired":
    case "pairing":
    case "waiting":
    case "choosing":
    case "terminal":
    case "incompatible":
    case "forgetting":
      return undefined;
  }
}

/** The state of an edit row, or a run row whose code rolled back a transaction. */
export type ChatChip = "pending" | "kept" | "undone" | "rolled back";

/** One row of a chat, as the panel draws it. */
export type ChatItem =
  | { kind: "user"; key: string; text: string }
  /** An agent's answer; `streaming` while it is the chat's last row on the turn the agent is on. */
  | { kind: "say"; key: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      key: string;
      label: string;
      target?: string;
      /** Where the target opens, for the docs a guide read. */
      link?: string;
      meta?: string;
      /** Why the call failed or was refused, as the tool said it. */
      error?: string;
      /** A project the call created: the row links to it, to open in a new tab. */
      opens?: { href: string; name: string };
      tone: ChatTone;
      spinning: boolean;
      chip?: ChatChip;
    }
  /** An edit refused in Ask mode: "This needs an edit to query.ts", until the user answers. */
  | { kind: "ask"; key: string; toolId: string; target?: string }
  | { kind: "allowed"; key: string }
  | { kind: "notice"; key: string; tone: "err" | "faint"; text: string }
  /** The agent is on a turn and no tool row spins: it thinks, or writes text still to come. */
  | { kind: "thinking"; key: string };

const RUNNING_LABELS: Readonly<Record<ConnectToolName, string>> = {
  get_project: "Reading the project",
  read_file: "Reading",
  get_problems: "Reading problems",
  get_latest_run: "Reading the latest run",
  run: "Running the project",
  apply_edits: "Editing",
  switch_release: "Switching release",
  create_project: "Creating a project",
  fork_project: "Forking the project",
  get_query_plans_settings: "Reading Query plans settings",
  set_query_plans_settings: "Changing Query plans",
  get_query_plans: "Reading query plans",
  get_guide: "Reading the guide",
  read_docs: "Reading docs",
};

const DONE_LABELS: Readonly<Record<ConnectToolName, string>> = {
  get_project: "Read the project",
  read_file: "Read",
  get_problems: "Read problems",
  get_latest_run: "Read the latest run",
  run: "Ran the project",
  apply_edits: "Edited",
  switch_release: "Switched release",
  create_project: "Created a project",
  fork_project: "Forked the project",
  get_query_plans_settings: "Read Query plans settings",
  set_query_plans_settings: "Changed Query plans",
  get_query_plans: "Read query plans",
  get_guide: "Read the guide",
  read_docs: "Read docs",
};

/** What turns stored rows into drawn rows: pending edits, the current turn, and Ask answers. */
export interface ChatItemOptions {
  /** The edits still waiting for Keep or Undo. A stored "pending" edit this page does not hold was kept. */
  pendingEdits: ReadonlySet<string>;
  /** The turn the agent is on in this chat, if any. */
  working: string | undefined;
  answers: Readonly<Record<string, ChatAnswer>>;
  /** Guided rows include the tool name. */
  guided?: boolean;
  /** Terminal rows have no turn; they run until they settle. */
  terminal?: boolean;
}

/** A finished call whose result its companion never got still ran: its row warns instead of failing. */
function getToolTone(entry: Extract<ConnectActivity, { kind: "tool" }>): ChatTone {
  if (entry.status === "failed") {
    return "err";
  }

  if (entry.status !== "done") {
    return "faint";
  }

  return entry.error ? "warn" : "ok";
}

function toToolItem(entry: Extract<ConnectActivity, { kind: "tool" }>, options: ChatItemOptions): ChatItem {
  const running = entry.status === "running";
  const spinning = running && (options.terminal === true || options.working !== undefined);
  const decision = entry.edit?.decision;
  const editChip: ChatChip | undefined =
    decision === "pending" ? (options.pendingEdits.has(entry.edit?.id ?? "") ? "pending" : "kept") : decision;
  const chip = editChip ?? (entry.summary?.rolledBack === true ? "rolled back" : undefined);
  const meta = options.guided
    ? entry.name
    : entry.status === "refused"
      ? "not available"
      : entry.status === "failed"
        ? (entry.summary?.meta ?? "failed")
        : entry.summary?.meta;

  return {
    kind: "tool",
    key: `x:${entry.id}`,
    label: entry.summary?.label ?? (running ? RUNNING_LABELS[entry.name] : DONE_LABELS[entry.name]),
    ...(entry.summary?.target ? { target: entry.summary.target } : {}),
    ...(entry.name === "read_docs" && entry.summary?.target ? { link: `https://${entry.summary.target}` } : {}),
    ...(meta ? { meta } : {}),
    ...(entry.error ? { error: entry.error.message } : {}),
    ...(entry.status === "done" && entry.summary?.createdProject
      ? {
          opens: {
            href: `/p/${encodeURIComponent(entry.summary.createdProject.id)}`,
            name: entry.summary.createdProject.name,
          },
        }
      : {}),
    tone: getToolTone(entry),
    spinning,
    ...(chip ? { chip } : {}),
  };
}

/**
 * A chat's rows as the panel draws them, oldest first
 *
 * While the agent is on a turn and no tool row spins, a last "thinking" row says it still works.
 */
export function listChatItems(entries: readonly ConnectActivity[], options: ChatItemOptions): ChatItem[] {
  const items = listEntryItems(entries, options);
  const isToolRunning = items.some((item) => item.kind === "tool" && item.spinning);

  return options.working === undefined || isToolRunning
    ? items
    : [...items, { kind: "thinking", key: `w:${options.working}` }];
}

function listEntryItems(entries: readonly ConnectActivity[], options: ChatItemOptions): ChatItem[] {
  return entries.flatMap((entry, index): ChatItem[] => {
    switch (entry.kind) {
      case "user":
        return [{ kind: "user", key: `u:${entry.id}`, text: entry.text }];

      case "text":
        return entry.text.trim() === ""
          ? []
          : [
              {
                kind: "say",
                key: `t:${entry.turn}:${entry.at}`,
                text: entry.text.trim(),
                streaming: entry.turn === options.working && index === entries.length - 1,
              },
            ];

      case "turn":
        if (entry.state === "failed") {
          return [
            {
              kind: "notice",
              key: `n:${entry.turn}:failed`,
              tone: "err",
              text: entry.error ?? "The agent stopped with an error.",
            },
          ];
        }

        return entry.state === "stopped"
          ? [{ kind: "notice", key: `n:${entry.turn}:stopped`, tone: "faint", text: "Stopped." }]
          : [];

      case "tool": {
        if (entry.status === "refused" && entry.error?.code === "edit_mode_required") {
          const answer = options.answers[entry.id];

          if (answer === undefined) {
            return [
              {
                kind: "ask",
                key: `a:${entry.id}`,
                toolId: entry.id,
                ...(entry.summary?.target ? { target: entry.summary.target } : {}),
              },
            ];
          }

          if (answer === "allowed") {
            return [{ kind: "allowed", key: `a:${entry.id}` }];
          }
        }

        return [toToolItem(entry, options)];
      }
    }
  });
}

/** "+8 −3" for an edit's files. */
export function sumEditCounts(files: readonly { added: number; removed: number }[]): {
  added: number;
  removed: number;
} {
  return files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), {
    added: 0,
    removed: 0,
  });
}
