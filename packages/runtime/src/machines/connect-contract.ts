import type {
  AgentId,
  AgentTuning,
  ChatContextEntry,
  ChatMode,
  ChatProject,
  CompanionInfo,
  ConnectMessage,
  ConnectToolCall,
  ConnectToolName,
  ConnectToolScope,
  FileChange,
  ProjectOrigin,
  RelayBusyFrame,
  RelayQuotaFrame,
  ToolError,
  TurnState,
} from "@drizzle-run/core/connect";

/** What the AI chat link machine and its host exchange: the services, the context, events and emitted events. */

/** What this browser remembers about its pairing. */
export interface ConnectPairing {
  secret: string;
  pairedAt: string;
  /** Set once a companion first connected with this secret: from then on the tab says "Start the companion". */
  confirmedAt?: string;
}

/** The host's WebSocket, reduced to what the link uses */
export interface ConnectSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

/** Callbacks the link passes to `openSocket` */
export interface ConnectSocketHandlers {
  open(): void;
  message(text: string): void;
  close(code: number, reason: string): void;
}

/** A tool call the host executes, already checked against its schema and the chat mode. */
export interface ConnectToolRequest {
  id: string;
  call: ConnectToolCall;
  conversation?: string;
  mode: ChatMode;
  /**
   * The project the call was checked against: the chat's, or the open one for a terminal call. The host refuses the
   * call when another project is open by the time it runs. Absent when no project was open.
   */
  projectId?: string;
}

/** The project open in the view the tools act on. */
export interface ConnectOpenProject {
  id: string;
  name?: string;
  origin?: ProjectOrigin;
}

/** What the tab keeps about a chat: the project its turns act on and its mode. */
export interface ConnectChat {
  /** The project its last message was about; undefined when it named none. */
  projectId: string | undefined;
  mode: ChatMode;
}

/** An agent's `run` of a community project, waiting for the user to run it or not. */
export interface PendingRun {
  /** The tool call's id. */
  id: string;
  request: ConnectToolRequest;
  /** The relay's id for the companion that asked: only it gets the answer. */
  peer: string;
  projectId: string;
  projectName?: string;
  conversation?: string;
  createdAt: number;
}

/** A row for the chat, such as "Read · query.ts · 15 lines" or "Edited · query.ts · +8 −3". */
export interface ConnectToolSummary {
  label: string;
  target?: string;
  meta?: string;
  /** A run whose code rolled back a transaction: the row shows a "rolled back" chip. */
  rolledBack?: boolean;
  /** A project the call created and saved: the row links to it, to open in a new tab. */
  createdProject?: { id: string; name: string };
}

/** The files an `apply_edits` call changed, as the host reports them. */
export interface PendingEditDraft {
  projectId: string;
  projectName: string;
  side?: 0 | 1;
  /** Where the edit landed on a side-by-side project, as the user reads it: "rc.5", "both sides". */
  where?: string;
  summary?: string;
  files: readonly FileChange[];
}

/** An edit waiting for the user's Keep or Undo */
export interface PendingEdit extends PendingEditDraft {
  id: string;
  toolCallId: string;
  createdAt: number;
}

/** How the user settled a pending edit. */
export type EditDecision = "kept" | "undone";

/** What the host's tool execution returns: a result for the agent, or a tool error */
export type ConnectToolOutcome =
  | {
      ok: true;
      result: unknown;
      summary?: ConnectToolSummary;
      pendingEdit?: PendingEditDraft;
    }
  | { ok: false; error: ToolError; summary?: ConnectToolSummary };

/** The host's side effects for the AI chat link */
export interface ConnectServices {
  loadPairing(): Promise<ConnectPairing | undefined>;
  savePairing(pairing: ConnectPairing): Promise<void>;
  clearPairing(): Promise<void>;
  /** The WebSocket URL of a room for a tab, such as `wss://drizzle.run/api/connect/rooms/<id>?role=tab`. */
  roomUrl(roomId: string): string;
  /**
   * Opens the room's WebSocket, offering `protocols` as its subprotocols: the room protocol and the proof the relay
   * checks the room id against, as `new WebSocket(url, protocols)` sends them.
   */
  openSocket(url: string, handlers: ConnectSocketHandlers, protocols: readonly string[]): ConnectSocket;
  /** Runs a tool call; `signal` aborts when the call is stopped, such as when the chat closes. */
  executeTool(request: ConnectToolRequest, signal: AbortSignal): Promise<ConnectToolOutcome>;
  /** Puts back the files an edit changed. Rejects (keeping the edit pending) when a file changed since. */
  undoEdit(edit: PendingEdit): Promise<void>;
  /** The tools the open view offers: a guide or a shared link read only. Defaults to `project`. */
  toolScope?(): ConnectToolScope;
  /** The project open in the view the tools act on, if any. */
  openProject?(): ConnectOpenProject | undefined;
  /** The edits a past page left waiting for Keep or Undo. */
  loadPendingEdits?(): Promise<readonly PendingEdit[]>;
  /** Keeps the edits waiting for Keep or Undo, so a reload still asks for them. */
  savePendingEdits?(edits: readonly PendingEdit[]): Promise<void>;
  createSecret?(): string;
  now?(): number;
  /** Tests only: PBKDF2 rounds, the same on both sides. */
  kdfIterations?: number;
}

/** One entry of the chat's activity: a user message, streamed text, a turn change, or a tool call */
export type ConnectActivity =
  | { kind: "user"; id: string; conversation: string; text: string; at: number }
  | { kind: "text"; conversation: string; turn: string; text: string; at: number }
  | { kind: "turn"; conversation: string; turn: string; state: TurnState; error?: string; at: number }
  | {
      kind: "tool";
      id: string;
      name: ConnectToolName;
      conversation?: string;
      /** `waiting`: a run of a community project, until the user runs it or not. */
      status: "waiting" | "running" | "done" | "failed" | "refused";
      summary?: ConnectToolSummary;
      error?: ToolError;
      /** The pending edit this call made, while it waits or after Keep or Undo. */
      edit?: { id: string; decision: "pending" | "kept" | "undone" };
      at: number;
    };

/** The connect machine's context */
export interface ConnectContext {
  pairing: ConnectPairing | undefined;
  companion: CompanionInfo | undefined;
  /** The relay's id for the companion that said hello: messages go to it, and only to it. */
  peer: string | undefined;
  /** A companion connected since this page opened, so its absence reads "stopped", not "not started". */
  companionSeen: boolean;
  /** Whether the chat dock is open: an open dock makes a link code on its own, once. */
  dock: "open" | "closed";
  /** The mode of the chat in front, and of terminal calls. Each chat keeps its own in `chats`. */
  mode: ChatMode;
  chats: Readonly<Record<string, ConnectChat>>;
  busy: RelayBusyFrame | undefined;
  /** This tab's share of today's AI chat, as the relay last told it. */
  quota: RelayQuotaFrame | undefined;
  /** The companion's protocol range when no version is shared. */
  incompatible: { min: number; max: number } | undefined;
  /** Why the relay closed the last connection, while reconnecting after it: too many from this network. */
  refusal: "rate_limited" | undefined;
  attempt: number;
  error: string;
  activity: readonly ConnectActivity[];
  pendingEdits: readonly PendingEdit[];
  /** Edits whose Undo waits behind another job: Keep cancels it. */
  queuedUndos: readonly string[];
  /** The edit whose Undo is putting files back now: Keep waits for it to settle. */
  runningUndo: string | undefined;
  /** Why the last Undo of an edit was refused, by edit id, until the edit is kept or undone. */
  undoErrors: Readonly<Record<string, string>>;
  pendingRuns: readonly PendingRun[];
}

/** Public events. Their names are part of the runtime's API. */
export type ConnectEvent =
  /** Creates a pairing secret and opens its room: the tab shows `npx @drizzle-run/connect <secret>`. */
  | { type: "pairing.create" }
  /** Forget this computer: tells a connected companion to forget too, then clears the pairing here. */
  | { type: "pairing.forget" }
  /** The chat dock opened: with no pairing yet, it makes a link code, unless one failed or the user forgot. */
  | { type: "dock.open" }
  | { type: "dock.close" }
  /** Reconnects now, such as when the tab comes back to the front. */
  | { type: "link.retry" }
  /** Closes this tab's link and keeps the pairing; `link.retry` connects again. */
  | { type: "link.disconnect" }
  /** This tab is in front: the companion sends tool calls without a chat here. */
  | { type: "tab.activate" }
  | { type: "chat.agent.choose"; agent: AgentId }
  /**
   * `scope` is the chat's view: a guide or a shared link always sends in Ask mode. `agent` is the chat's agent; one
   * the companion does not offer falls back to the companion's choice. `tuning` picks that agent's model and effort;
   * a stale effort is dropped, and a model it no longer offers too. `context` is the chat so far, which the companion
   * gives only to a new agent session.
   */
  | {
      type: "chat.message.send";
      conversation: string;
      text: string;
      project?: ChatProject;
      scope?: ConnectToolScope;
      agent?: AgentId;
      tuning?: AgentTuning;
      context?: readonly ChatContextEntry[];
    }
  | { type: "chat.turn.stop"; conversation: string }
  /** `conversation` sets that chat's mode too; without it, only terminal calls and the next new chat follow it. */
  | { type: "chat.mode.set"; mode: ChatMode; conversation?: string }
  | { type: "edit.keep"; id: string }
  | { type: "edit.undo"; id: string }
  /** The open view or its project changed: chats about another project stop, and their runs are declined. */
  | { type: "view.changed" }
  /** The user runs a community project an agent asked to run. */
  | { type: "run.confirm"; id: string }
  | { type: "run.decline"; id: string };

/** A message the tab seals for the companion. */
export type CompanionMessage = Exclude<ConnectMessage, { type: "hello" }>;

/** What the link actor reports to the machine. `peer` is the relay's id for the companion. */
export type LinkEvent =
  | { type: "link.opened" }
  | { type: "link.closed"; code: number; reason: string }
  | { type: "companion.greeted"; peer: string; companion: CompanionInfo | undefined }
  | { type: "companion.left" }
  | { type: "companion.incompatible"; range: { min: number; max: number } }
  | { type: "companion.message"; peer: string; message: CompanionMessage }
  /** A message for a companion that is gone or never said hello: it was not sent. */
  | { type: "link.send.refused"; peer: string; message: CompanionMessage }
  | { type: "relay.busy"; busy: RelayBusyFrame }
  | { type: "relay.quota"; quota: RelayQuotaFrame }
  | { type: "relay.error"; code: string; message: string };

/** What the jobs actor reports to the machine. */
export type JobEvent =
  /** `peer` is the companion that made the call: only it gets the result. */
  | { type: "tool.settled"; request: ConnectToolRequest; peer: string; outcome: ConnectToolOutcome }
  /** An Undo left the queue and started putting files back. */
  | { type: "undo.started"; id: string }
  | { type: "undo.settled"; id: string; error?: string }
  /** A waiting run ends unrun: the user declined, it lapsed, its turn ended, or its project closed. */
  | { type: "run.declined"; id: string; message: string }
  /** The pending edits changed: keep them for the next page. */
  | { type: "edits.changed" };

/** Events only the machine's own actors send. */
export type InternalEvent = LinkEvent | JobEvent;

/** A tool call or an undo, queued for the jobs actor. */
export type QueuedJob =
  | { type: "tool.run"; request: ConnectToolRequest; peer: string }
  | { type: "undo.run"; edit: PendingEdit };

/** What the jobs actor takes: a job to queue, or a queued Undo to drop before it runs, as when the edit is kept. */
export type Job = QueuedJob | { type: "undo.cancel"; id: string };

/** A message for the link actor to seal and send to `peer`, the companion it is for. */
export type LinkCommand = { type: "link.send"; peer: string; message: CompanionMessage };

/** The pending edits for the edit store actor to save. */
export type EditStoreCommand = { type: "edits.save"; edits: readonly PendingEdit[] };

/** Emitted for the host: activity for the chat, edit decisions, and the end of a pairing */
export type ConnectEmitted =
  | { type: "activity.added"; activity: ConnectActivity }
  /** An edit tool was refused in Ask mode: the chat offers "Allow edits in this chat". */
  | { type: "edit.requested"; tool: ConnectToolName; conversation?: string }
  | { type: "edit.pending"; edit: PendingEdit }
  | { type: "edit.kept"; edit: PendingEdit }
  | { type: "edit.undone"; edit: PendingEdit }
  | { type: "edit.undo.failed"; edit: PendingEdit; error: string }
  /** An agent asked to run a community project: the page asks the user. */
  | { type: "run.requested"; run: PendingRun }
  | { type: "pairing.forgotten" };
