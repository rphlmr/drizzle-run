import type { ConnectToolName, ConnectToolScope } from "./tools.ts";

/**
 * The AI chat link, in two layers.
 *
 * 1. Relay frames: plain JSON text the relay reads to route. They carry only peer ids,
 *    roles, limits, and sealed payloads (`d`), never project code or chat text.
 * 2. Connect messages: JSON sealed with the pairing key (see `channel.ts`), which only the
 *    tab and the companion can read.
 */

/**
 * Versions of the sealed message format this code speaks. A peer picks the highest shared one.
 *
 * It covers the messages only: a change to how a pairing secret derives its room, proof or key (`crypto.ts`) puts
 * peers in different rooms, where they never get to compare versions.
 */
export const CONNECT_PROTOCOL = { min: 1, max: 1 } as const;

/** Which end of the link a client is. */
export type ConnectRole = "tab" | "companion";

/** Both roles. */
export const CONNECT_ROLES: readonly ConnectRole[] = ["tab", "companion"];

/** Limits both sides and the relay agree on. */
export const CONNECT_LIMITS = {
  /** Largest relay frame, in UTF-8 bytes. The relay drops bigger ones with `too_large`. */
  maxFrameBytes: 512 * 1024,
  /** Tool results are cut to this many characters before sealing, so a frame stays under the cap. */
  maxToolResultChars: 300_000,
  /** The companion batches streamed agent text this long before sending it. */
  textBatchMs: 250,
  /** Token bucket the relay keeps per socket: a burst of frames, then a steady rate per second. */
  relayBurst: 60,
  relayPerSecond: 20,
  /** Longest chat message a tab sends. */
  maxChatChars: 20_000,
  /** Most text the chat so far may carry, over all its entries: a tab keeps the latest entries that fit. */
  maxChatContextChars: 60_000,
  /** Most entries the chat so far may carry. */
  maxChatContextEntries: 400,
} as const;

/** The relay's route for a room: `/api/connect/rooms/<roomId>?role=tab|companion`. */
export const CONNECT_ROUTE_PREFIX = "/api/connect/rooms/";

/**
 * The WebSocket subprotocol a tab and a companion offer, followed by the room proof as a second one
 *
 * Sent in `Sec-WebSocket-Protocol`, a header, so the proof stays out of URLs that logs and extensions see. The relay
 * answers with this protocol alone, refusals included, since a client that offered subprotocols fails a handshake
 * answered without one.
 */
export const CONNECT_ROOM_PROTOCOL = "drizzle-run-connect";

/** The subprotocols a tab or a companion offers: Drizzle Run's, then the proof that it holds the pairing secret. */
export function roomProtocols(roomProof: string): readonly string[] {
  return [CONNECT_ROOM_PROTOCOL, roomProof];
}

/** Where `npx @drizzle-run/connect` connects unless told otherwise. */
export const DEFAULT_CONNECT_ORIGIN = "https://drizzle.run";

/** WebSocket close codes the relay uses. */
export const RELAY_CLOSE = {
  /** The room was idle too long; reconnect when there is something to do. */
  expired: 4000,
  /** A newer companion joined the room. */
  replaced: 4001,
  /** The room has as many tabs as it takes. */
  full: 4003,
  /** The connection broke the frame rules too often. */
  misbehaving: 4004,
  /** Too many connections to this room from the client's network: reconnect with backoff. */
  rateLimited: 4005,
  /** The connection did not prove it holds the room's pairing code; reconnecting with the same code cannot help. */
  unproven: 4006,
} as const;

/** A client the relay routes to. */
export interface RelayPeer {
  id: string;
  role: ConnectRole;
}

/** What a client sends the relay: a sealed payload, to one peer or (from a tab) to the companion. */
export interface RelayClientFrame {
  t: "send";
  to?: string;
  d: string;
}

/** The relay's typed refusal when a daily limit is reached. The chat is kept; retry after `retryAt`. */
export interface RelayBusyFrame {
  t: "busy";
  /** `daily`: every room together reached today's limit. `room`: this room did. */
  scope: "daily" | "room";
  /** ISO time, the next UTC midnight. */
  retryAt: string;
}

/**
 * How much of today's AI chat this client's share has used, sent only to the sockets of that share: after a tab's
 * `welcome`, and again whenever the room reserves more of the day's quota for it. Counts reserved messages, so it
 * moves ahead of use in steps.
 */
export interface RelayQuotaFrame {
  t: "quota";
  /** `account`: the share of the signed-in user. `connection`: the share of a signed-out client's address. */
  per: "account" | "connection";
  /** Messages reserved for this share today. */
  used: number;
  /** Messages this share may forward today. */
  limit: number;
  /** ISO time, the next UTC midnight, when `used` starts again from 0. */
  resetAt: string;
}

/** Why the relay refused a frame. */
export type RelayErrorCode = "rate_limited" | "too_large" | "bad_frame" | "no_peer";

/** What the relay sends a client. */
export type RelayServerFrame =
  | {
      t: "welcome";
      id: string;
      role: ConnectRole;
      peers: readonly RelayPeer[];
      maxFrameBytes: number;
    }
  | { t: "peer"; event: "join" | "leave"; peer: RelayPeer }
  | { t: "data"; from: string; d: string }
  | RelayBusyFrame
  | RelayQuotaFrame
  | { t: "error"; code: RelayErrorCode; message: string };

/** The coding agents the companion can run, in the order it lists them. */
export const AGENT_IDS = ["claude", "codex", "grok"] as const;

/** A coding agent the companion can run. */
export type AgentId = (typeof AGENT_IDS)[number];

/** Display names of the agents. */
export const AGENT_NAMES: Record<AgentId, string> = { claude: "Claude Code", codex: "Codex", grok: "Grok" };

/** How long the agent thinks before it answers, in the levels the CLIs name. */
export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Every effort level, from the quickest to the deepest. */
export const AGENT_EFFORTS: readonly AgentEffort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * The model ids a companion offers and a turn may ask for: an alias, a slug, or a full name with a context suffix
 * such as `[1m]`. Never starts with `-`, so a model id is never read as another option.
 */
export const AGENT_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/;

/** A model the agent CLI takes, and the effort levels it accepts. */
export interface AgentModel {
  /** What the CLI's model option takes, such as an alias or a model slug. */
  id: string;
  name: string;
  efforts: readonly AgentEffort[];
}

/** An agent installed where the companion runs. */
export interface CompanionAgent {
  id: AgentId;
  name: string;
  version?: string;
  /** The models a chat may pick; empty or absent, the CLI's own default runs. */
  models?: readonly AgentModel[];
  /** The model and effort a chat starts on, until the user picks others. */
  defaults?: AgentTuning;
}

/** The model and effort a chat turn asks for. Each one left out runs the CLI's own default. */
export interface AgentTuning {
  model?: string;
  effort?: AgentEffort;
}

/**
 * Get the effort levels an agent accepts with a model
 *
 * Returns an empty list without a model, or for a model the agent does not offer: an effort always goes with a
 * model.
 */
export function getAgentEfforts(agent: CompanionAgent, model: string | undefined): readonly AgentEffort[] {
  return agent.models?.find((option) => option.id === model)?.efforts ?? [];
}

/**
 * Fit a tuning to what the agent offers now
 *
 * Keeps the model and effort when the agent takes both, else the model alone when it is still offered, else nothing.
 * For a saved choice that went stale; a turn's own check is `resolveAgentTuning`.
 */
export function fitAgentTuning(agent: CompanionAgent, tuning: AgentTuning): AgentTuning {
  return resolveAgentTuning(agent, tuning) ?? resolveAgentTuning(agent, { model: tuning.model }) ?? {};
}

/**
 * Resolve the tuning a turn may run with
 *
 * Returns the tuning when the agent offers its model and accepts its effort with that model, and `null` otherwise.
 * The companion refuses a turn that resolves to `null`; the tab drops a saved choice the agent no longer offers.
 */
export function resolveAgentTuning(agent: CompanionAgent, tuning: AgentTuning): AgentTuning | null {
  const isModelOffered =
    tuning.model === undefined || (agent.models ?? []).some((option) => option.id === tuning.model);

  if (!isModelOffered) {
    return null;
  }

  if (tuning.effort !== undefined && !getAgentEfforts(agent, tuning.model).includes(tuning.effort)) {
    return null;
  }

  return {
    ...(tuning.model === undefined ? {} : { model: tuning.model }),
    ...(tuning.effort === undefined ? {} : { effort: tuning.effort }),
  };
}

/** What the companion tells a tab about itself in its hello. */
export interface CompanionInfo {
  /** The `@drizzle-run/connect` version. */
  version: string;
  /** `chat`: the companion runs the agent; `mcp`: a terminal agent uses the tools (`--mcp`). */
  mode: "chat" | "mcp";
  agents: readonly CompanionAgent[];
  /** The agent this companion run chats with, once chosen. */
  agent?: AgentId;
}

/** Ask reads and runs. Edit may also change files, each change waiting for Keep or Undo. */
export type ChatMode = "ask" | "edit";

/** Why a tool call failed. */
export type ToolErrorCode =
  | "invalid_input"
  | "unknown_tool"
  | "edit_mode_required"
  | "no_project"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "busy"
  | "failed"
  | "timeout"
  | "no_tab";

/** A failed tool call's code and message for the agent. */
export interface ToolError {
  code: ToolErrorCode;
  message: string;
}

/** Where an agent turn stands. */
export type TurnState = "started" | "done" | "failed" | "stopped";

/** One message of the chat so far: what the user asked, or what an agent answered. */
export interface ChatContextEntry {
  from: "user" | "agent";
  text: string;
}

/** One side of a side-by-side project, as a chat turn names it: side 0, "0.45", drizzle-orm 0.45.4. */
export interface ChatProjectSide {
  side: 0 | 1;
  /** The side's name in the UI, such as "0.45" or "rc.5". */
  name: string;
  /** The side's drizzle-orm version. */
  orm: string;
  /** The side's database, such as "PostgreSQL"; an older tab leaves it out. */
  database?: string;
}

/**
 * Where a project came from, when someone else wrote it
 *
 * `community`: forked from a shared link or a Community project. Its files, names and run output are the author's,
 * so agents read them as data and the tab asks before an agent runs it.
 */
export type ProjectOrigin = "community";

/** The project a chat turn is about. `sides` is present only on a side-by-side project. */
export interface ChatProject {
  id: string;
  name: string;
  sides?: readonly [ChatProjectSide, ChatProjectSide];
  origin?: ProjectOrigin;
}

/** Every sealed message, without the channel's own fields. */
export type ConnectMessage =
  | {
      type: "hello";
      role: ConnectRole;
      protocol: { min: number; max: number };
      companion?: CompanionInfo;
    }
  /** The tab asks the companion to forget the pairing; it answers `forgotten` and exits. */
  | { type: "forget" }
  | { type: "forgotten" }
  /** The tab is the one in front: tools without a chat go to it. */
  | { type: "tab.active" }
  | { type: "agent.choose"; agent: AgentId }
  | { type: "agent.chosen"; agent: AgentId }
  /**
   * `scope` names the tools the chat's view offers; without it, a workspace project's (`project`). `agent` is the
   * chat's agent; without it, the one the companion chose. `model` and `effort` pick from what that agent offers; each
   * one left out runs the CLI's own default. `context` is the chat so far, before this message: the companion gives it
   * to the agent only on the first turn of a new session (a chat that moved agents, or a companion that restarted).
   */
  | ({
      type: "chat.send";
      conversation: string;
      text: string;
      mode: ChatMode;
      project?: ChatProject;
      scope?: ConnectToolScope;
      agent?: AgentId;
      context?: readonly ChatContextEntry[];
    } & AgentTuning)
  | { type: "chat.stop"; conversation: string }
  | { type: "agent.text"; conversation: string; turn: string; text: string }
  | { type: "agent.turn"; conversation: string; turn: string; state: TurnState; error?: string }
  | { type: "tool.call"; id: string; name: ConnectToolName; input: unknown; conversation?: string }
  /**
   * A tool call naming a tool this version does not know, as a newer companion may send. Only reading makes one: the
   * tab answers it with `unknown_tool` instead of leaving the call to time out.
   */
  | { type: "tool.unknown"; id: string; name: string; conversation?: string }
  | { type: "tool.result"; id: string; ok: true; result: unknown }
  | { type: "tool.result"; id: string; ok: false; error: ToolError };

/** Every sealed message type. */
export type ConnectMessageType = ConnectMessage["type"];

/**
 * Get the protocol version both sides speak
 *
 * Returns the highest version both ranges share, or undefined when they do not overlap.
 */
export function sharedProtocolVersion(
  ours: { min: number; max: number },
  theirs: { min: number; max: number },
): number | undefined {
  const highestVersion = Math.min(ours.max, theirs.max);

  return highestVersion >= Math.max(ours.min, theirs.min) ? highestVersion : undefined;
}

/** UTF-8 byte length, the unit of the relay's frame cap. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** The next UTC midnight after `now`, when daily limits reset. */
export function nextUtcMidnight(now: number): Date {
  const date = new Date(now);

  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
}

/** The published companion, as a tab on drizzle.run shows it. */
export const CONNECT_PACKAGE_COMMAND = "npx @drizzle-run/connect";

/** The companion built in a Drizzle Run checkout, run from its root: what a tab on a local server shows. */
export const CONNECT_LOCAL_COMMAND = "node packages/connect/dist/cli.js";

/**
 * Check whether an origin is a server on this computer
 *
 * True for localhost, 127.0.0.1, or [::1]; false for anything else, including text that is not a URL.
 */
export function isLocalOrigin(origin: string): boolean {
  let hostname: string;

  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }

  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Get the companion command a tab shows
 *
 * The command is `npx @drizzle-run/connect <secret>` to pair, or without a secret
 * to rejoin; `latest` asks npx for the newest companion. On a local server it is the checkout's
 * own build instead, and `--relay` is added whenever the tab is not on the default origin.
 *
 * `packageCommand` replaces the published companion, as a pull request preview does with its pkg.pr.new build
 * (`npx https://pkg.pr.new/...`). That build is pinned to a commit, so `latest` adds nothing to it.
 */
export function connectCommand(
  options: { secret?: string; origin?: string; mcp?: boolean; latest?: boolean; packageCommand?: string } = {},
): string {
  const isLocal = options.origin !== undefined && isLocalOrigin(options.origin);
  const packageCommand =
    options.packageCommand ?? (options.latest ? `${CONNECT_PACKAGE_COMMAND}@latest` : CONNECT_PACKAGE_COMMAND);
  const parts = [isLocal ? CONNECT_LOCAL_COMMAND : packageCommand];

  if (options.secret !== undefined) {
    parts.push(options.secret);
  }

  if (options.mcp) {
    parts.push("--mcp");
  }

  if (options.origin !== undefined && options.origin !== DEFAULT_CONNECT_ORIGIN) {
    parts.push("--relay", options.origin);
  }

  return parts.join(" ");
}
