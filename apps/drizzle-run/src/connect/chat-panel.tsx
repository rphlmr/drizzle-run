import {
  AGENT_NAMES,
  CONNECT_LIMITS,
  type ChatMode,
  type ChatProject,
  type ConnectToolScope,
} from "@drizzle-run/core/connect";
import type { ConnectActivity, ConnectStatus } from "@drizzle-run/runtime/machines";
import { LockIcon, MessageCircleIcon, ShieldAlertIcon, TerminalIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { DropdownMenuItem } from "../components/ui/dropdown-menu";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/utils";
import { Hint } from "../ui/hint";
import { RailResizeHandle } from "../ui/rail-resize-handle";
import { AgentTuningMenu, useChatTuning } from "./agent-tuning-menu";
import { getChatContext } from "./chat-history";
import {
  BusyCard,
  ChatMessages,
  Chip,
  CommunityNote,
  Composer,
  Dot,
  EditDecisionButtons,
  EditSummary,
  EmptyBody,
  ForgettingBody,
  ReadOnlyModeLine,
  IncompatibleBody,
  LimitedCard,
  OffBanner,
  OffBody,
  PairBody,
  PendingBar,
  QuotaLine,
  ReturnBody,
  SendButton,
  SetupBody,
  SharedLinkNote,
  UntrustedNote,
  StopButton,
  StoppedBanner,
  TerminalNote,
  useStickToBottom,
} from "./chat-parts";
import {
  getAgentName,
  getChatBody,
  getQuotaLine,
  getChatComposer,
  getChatHead,
  listChatItems,
  retryTime,
  type ChatItem,
} from "./chat-view";
import {
  useConnect,
  useConnectAvailable,
  useConnectSettings,
  usePendingEdits,
  usePendingRuns,
  type ConnectApi,
  type ProjectTrustControls,
} from "./connect-provider";
import { useChatHistory, type ChatHistoryState } from "./use-chat-history";

/**
 * A resizable AI chat dock beside the output. Available on desktop only.
 */

export interface ChatTarget {
  conversation: string;
  /** The open project; a side-by-side one names both sides, so the agent knows which side each answer is about. */
  project: ChatProject;
  /** The files the agent sees, for "Claude Code sees query.ts, schema.ts, seed.ts". */
  files: readonly string[];
  /** The tools the view offers; every message carries it, so the companion offers the same. */
  scope: ConnectToolScope;
  /** An untrusted project: opens the trust confirmation from the chat's note. */
  onTrust?: () => void;
  /**
   * A guide's chat: Ask only, with the guide's read tools, and the learner's place under the
   * composer, such as "Step 2 of 3 · Transactions".
   */
  guided?: { position: string };
}

const OPEN_KEY = "drizzle-run:chat-open";

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** Whether the dock is open, remembered in this browser across projects. */
export function useChatOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(readOpen);

  return [
    open,
    (next) => {
      setOpen(next);

      try {
        window.localStorage.setItem(OPEN_KEY, next ? "1" : "0");
      } catch {
        // A private window may refuse storage; the dock still opens for this page.
      }
    },
  ];
}

/** The last agent this page saw, for the head of a stopped or busy chat. */
function useLastAgent(status: ConnectStatus): string | undefined {
  const [last, setLast] = useState<string>();
  const current = getAgentName(status, last);

  if (current !== undefined && current !== last && (status.kind === "ready" || status.kind === "terminal")) {
    setLast(current);
  }

  return current;
}

interface ChatToggleProps {
  open: boolean;
  onToggle: () => void;
}

/** The header button, pressed while the dock is open, with the link's status dot. */
export function ChatToggle(props: ChatToggleProps) {
  return useConnectAvailable() ? <ConnectedToggle {...props} /> : null;
}

function ConnectedToggle({ open, onToggle }: ChatToggleProps) {
  const connect = useConnect();
  const head = getChatHead(connect.status, undefined);

  return (
    <Hint content="Chat with your coding agent">
      <Button
        variant="outline"
        aria-pressed={open}
        className="font-semibold aria-pressed:border-segment aria-pressed:bg-segment aria-pressed:text-segment-fg aria-pressed:hover:opacity-88 [&>svg]:size-3.75"
        onClick={onToggle}
      >
        <MessageCircleIcon aria-hidden="true" />
        Ask AI
        <Dot
          tone={head.tone}
          className={cn(open ? "shadow-[0_0_0_2px_var(--segment-active-bg)]" : "shadow-[0_0_0_2px_var(--surface)]")}
        />
        <span className="sr-only">{head.status}</span>
      </Button>
    </Hint>
  );
}

const SUGGESTIONS = [
  "Explain what this project does",
  "Why does the latest run show these results?",
  "Add a query that joins two tables",
];

function formatTerminalTime(at: number) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    new Date(at),
  );
}

/** Terminal rows belong to this page session rather than a stored conversation. */
function listTerminalItems(activity: readonly ConnectActivity[], pending: ReadonlySet<string>): ChatItem[] {
  const rows = activity.filter(
    (entry): entry is Extract<ConnectActivity, { kind: "tool" }> =>
      entry.kind === "tool" && entry.conversation === undefined,
  );

  return listChatItems(rows, { pendingEdits: pending, working: undefined, answers: {}, terminal: true }).map((item) => {
    const entry = rows.find((row) => `x:${row.id}` === item.key);

    return item.kind === "tool" && entry !== undefined
      ? { ...item, meta: [item.meta, formatTerminalTime(entry.at)].filter(Boolean).join(" · ") }
      : item;
  });
}

type ChatDockProps = ChatTarget & {
  open: boolean;
  onClose: () => void;
  /** Spacing around the dock, for a row without a gap. */
  className?: string;
};

/**
 * AI chat dock
 *
 * The dock as the last child of a work row, the work area just before it. Renders nothing outside
 * the workspace, where there is no link. Its width lasts while the page does, closed or open.
 */
export function ChatDock(props: ChatDockProps) {
  return useConnectAvailable() ? <ConnectedDock {...props} /> : null;
}

function ConnectedDock({ open, onClose, className, ...target }: ChatDockProps) {
  const connect = useConnect();
  const history = useChatHistory({
    settings: useConnectSettings(),
    conversation: target.conversation,
    live: connect.activity,
    applyMode: (conversation, mode) => connect.setMode(mode, conversation),
  });
  const dock = useRef<HTMLDivElement>(null);
  const [dockWidthPx, setDockWidthPx] = useState<number | null>(null);

  if (!open) {
    return null;
  }

  return (
    <div
      ref={dock}
      className={cn("relative flex min-h-0 w-90 max-w-1/2 min-w-90 shrink-0", className)}
      style={dockWidthPx === null ? undefined : { width: dockWidthPx }}
    >
      <ChatPanel connect={connect} history={history} target={target} onClose={onClose} />
      <RailResizeHandle
        rail={dock}
        edge="left"
        onWidthChange={setDockWidthPx}
        label="Resize AI chat"
        className="-left-3"
      />
    </div>
  );
}

function ChatPanel({
  connect,
  history,
  target,
  onClose,
}: {
  connect: ConnectApi;
  history: ChatHistoryState;
  target: ChatTarget;
  onClose: () => void;
}) {
  const { status } = connect;
  const readyCompanion = status.kind === "ready" ? status.companion : undefined;
  const { tuning, last, pick } = useChatTuning(readyCompanion, history);
  const lastAgent = useLastAgent(status);
  const agent = tuning === undefined ? lastAgent : AGENT_NAMES[tuning.agent];
  const head = getChatHead(status, agent);
  const pending = connect.pendingEdits.filter((edit) => edit.projectId === target.project.id);
  const pendingIds = useMemo(() => new Set(connect.pendingEdits.map((edit) => edit.id)), [connect.pendingEdits]);
  const working = connect.working(target.conversation);
  const terminal = status.kind === "terminal";
  const guided = target.guided;
  const readOnly = target.scope === "snapshot" || target.scope === "untrusted";
  const items = terminal
    ? listTerminalItems(connect.activity, pendingIds)
    : listChatItems(history.entries, {
        pendingEdits: pendingIds,
        working,
        answers: history.answers,
        guided: guided !== undefined,
      });
  const body = getChatBody(status, items.length > 0);
  const quotaLine = getQuotaLine(connect.quota);
  const composer = getChatComposer(
    status,
    working !== undefined,
    agent,
    guided
      ? "Ask about this step"
      : readOnly
        ? "Ask about this project"
        : "Ask about this project, or ask for a change",
  );
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const { attachScroller, onScroll } = useStickToBottom();
  const { actor } = connect;

  useEffect(() => {
    actor.send({ type: "dock.open" });

    return () => actor.send({ type: "dock.close" });
  }, [actor]);

  const setMode = (mode: ChatMode) => {
    history.setMode(mode);
  };
  const community = target.project.origin === "community";
  const note =
    target.scope === "snapshot" ? (
      <SharedLinkNote />
    ) : target.scope === "untrusted" && target.onTrust !== undefined ? (
      <UntrustedNote onTrust={target.onTrust} />
    ) : community ? (
      <CommunityNote />
    ) : null;
  const send = () => {
    const text = draft.trim();

    // A message before the stored chat loaded would go without the chat so far, and its choice would not be kept.
    if (text === "" || composer === undefined || composer.disabled || working !== undefined || !history.loaded) {
      return;
    }

    const context = getChatContext(history.entries, {
      maxChars: CONNECT_LIMITS.maxChatContextChars,
      maxEntries: CONNECT_LIMITS.maxChatContextEntries,
    });

    connect.send(target.conversation, text, {
      project: target.project,
      scope: target.scope,
      ...(tuning === undefined ? {} : { tuning }),
      ...(context.length === 0 ? {} : { context }),
    });

    if (tuning !== undefined && history.tuning === undefined) {
      history.setTuning(tuning);
    }

    setDraft("");
  };
  const command = connect.command;
  const secret = status.kind === "pairing" ? status.secret : undefined;

  return (
    <section
      className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-surface"
      aria-label="AI chat"
    >
      <div className="flex min-h-13 shrink-0 items-center gap-2.5 border-b border-border py-0 pr-2 pl-3">
        <span className="grid size-7.5 shrink-0 place-items-center rounded-base border-[1.5px] border-card-border bg-surface-2">
          <TerminalIcon className="size-4 stroke-[2.2]" aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <b className="truncate text-[13.5px] font-[650]">{head.name}</b>
          <output className="flex min-w-0 items-center gap-1.5 text-[11.5px] whitespace-nowrap text-muted">
            <Dot tone={head.tone} />
            <span className="truncate">{guided && status.kind === "ready" ? "Connected" : head.status}</span>
            {guided && (
              <span className="inline-flex shrink-0 items-center gap-1 font-semibold">
                <span aria-hidden="true">·</span>
                <LockIcon className="size-2.75 stroke-[2.2]" aria-hidden="true" />
                Ask only
              </span>
            )}
          </output>
        </div>
        {(status.kind === "ready" || status.kind === "terminal") && (
          <Button variant="outline" className="h-7 min-h-7 px-2.25 text-[12px]" onClick={connect.disconnect}>
            Disconnect
          </Button>
        )}
        <Button variant="ghost" className="size-7 min-h-7 p-0" aria-label="Close chat" onClick={onClose}>
          <XIcon className="size-3.5 stroke-[2.2]" aria-hidden="true" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" ref={attachScroller} onScroll={onScroll}>
        {body === "loading" && (
          <div className="flex flex-col gap-3 px-4 py-5">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
        {body === "setup" && (
          <SetupBody
            command={status.kind === "pairing" ? command : undefined}
            secret={secret}
            {...(status.kind === "unpaired" && status.reason === "failed" ? { error: status.error } : {})}
            {...(status.kind === "unpaired" && (status.reason === "failed" || status.reason === "forgotten")
              ? { onNewCode: connect.pair }
              : {})}
          />
        )}
        {body === "pair" && status.kind === "choosing" && (
          <PairBody
            companion={status.companion}
            command={command ?? connect.commands.rejoin}
            rejoin={connect.commands.rejoin}
            onStart={connect.chooseAgent}
            onCancel={onClose}
          />
        )}
        {body === "return" && (
          <ReturnBody
            command={command ?? connect.commands.rejoin}
            projectName={target.project.name}
            onForget={connect.forget}
          />
        )}
        {body === "off" && <OffBody onReconnect={connect.retry} onForget={connect.forget} />}
        {body === "incompatible" && <IncompatibleBody command={connect.commands.update} onForget={connect.forget} />}
        {body === "forgetting" && <ForgettingBody />}
        {body === "empty" && !guided && note !== null && <div className="px-3 pt-3.5">{note}</div>}
        {body === "empty" && !guided && (
          <EmptyBody
            projectName={target.project.name}
            agent={agent ?? "The agent"}
            files={target.files}
            suggestions={SUGGESTIONS}
            onSuggestion={(text) => {
              setDraft(text);
              input.current?.focus();
            }}
            onForget={connect.forget}
          />
        )}
        {(body === "messages" || (body === "empty" && guided)) && (
          <div className="flex flex-col gap-2.5 px-3 py-3.5" data-slot="chat-messages">
            {terminal && <TerminalNote community={community} />}
            {(readOnly || !terminal) && note}
            <ChatMessages
              items={items}
              agent={agent ?? "The agent"}
              onAllow={(toolId) => {
                history.answer(toolId, "allowed");
                setMode("edit");
              }}
              onDismiss={(toolId) => history.answer(toolId, "dismissed")}
            />
            {status.kind === "disconnected" && <StoppedBanner command={command ?? connect.commands.rejoin} />}
            {status.kind === "off" && <OffBanner onReconnect={connect.retry} />}
            {status.kind === "busy" && <BusyCard time={retryTime(status.retryAt)} />}
            {status.kind === "limited" && <LimitedCard />}
          </div>
        )}
      </div>
      {pending.length > 0 && (
        <PendingBar
          edits={pending}
          error={connect.undoError}
          undoState={connect.undoState}
          onKeep={connect.keep}
          onUndo={connect.undo}
        />
      )}
      {composer && (body === "messages" || body === "empty") && (
        <div className="shrink-0 px-3 pb-3">
          {guided && <ReadOnlyModeLine />}
          <Composer
            inputRef={input}
            draft={draft}
            onDraft={setDraft}
            placeholder={composer.placeholder}
            disabled={composer.disabled}
            label={guided ? "Question about this step" : "Message to the agent"}
            height="h-14"
            fontSize="text-[13px]"
            onSend={send}
            footer={
              <>
                {guided ? (
                  <span className="min-w-0 truncate pl-1 text-[12px] text-muted">{guided.position}</span>
                ) : readOnly ? (
                  <span
                    className="inline-flex items-center gap-1 pl-1 text-[12px] font-semibold text-muted"
                    data-slot="read-only-mode"
                  >
                    <LockIcon className="size-2.75 stroke-[2.2]" aria-hidden="true" />
                    Read only
                  </span>
                ) : (
                  <fieldset aria-label="Mode" className="flex min-w-auto rounded-base bg-surface-2 p-0.5">
                    {(["ask", "edit"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={history.mode === mode}
                        disabled={composer.disabled}
                        className="h-6.5 cursor-pointer rounded-base border-0 bg-transparent px-2.5 text-[12px] font-semibold text-muted disabled:cursor-not-allowed aria-pressed:bg-segment aria-pressed:text-segment-fg"
                        onClick={() => setMode(mode)}
                      >
                        {mode === "ask" ? "Ask" : "Edit"}
                      </button>
                    ))}
                  </fieldset>
                )}
                <div className="flex-1" />
                {readyCompanion && tuning && (
                  <AgentTuningMenu
                    agents={readyCompanion.agents}
                    tuning={tuning}
                    last={last}
                    disabled={composer.disabled || working !== undefined}
                    onChange={pick}
                  />
                )}
                {working !== undefined ? (
                  <StopButton onClick={() => connect.stop(target.conversation)} />
                ) : (
                  <SendButton disabled={composer.disabled || !history.loaded || draft.trim() === ""} onClick={send} />
                )}
              </>
            }
          />
          {!guided && (
            <p className="mt-1.5 mb-0 px-0.5 text-[11.5px] text-muted">
              {readOnly
                ? "AI reads and explains only."
                : history.mode === "ask"
                  ? "Ask reads and runs. It never edits."
                  : "Edit changes files. Each change waits for Keep or Undo."}
            </p>
          )}
          {quotaLine && (
            <div className="mt-1 px-0.5">
              <QuotaLine line={quotaLine} />
            </div>
          )}
        </div>
      )}
      {terminal && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-surface-2 px-3 py-2.5 text-[12px] text-muted">
          <span>Started with</span>
          <code className="font-mono text-[11.5px] text-text">{connect.commands.mcp}</code>
          {quotaLine && (
            <div className="ml-auto min-w-0">
              <QuotaLine line={quotaLine} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** The project menu's trust act: allowing AI edits asks for confirmation, stopping them does not. */
export function TrustMenuItem({ trust }: { trust: ProjectTrustControls }) {
  return trust.state === "untrusted" ? (
    <DropdownMenuItem onClick={trust.requestTrust}>Allow AI edits…</DropdownMenuItem>
  ) : (
    <DropdownMenuItem onClick={trust.untrust}>Stop AI edits</DropdownMenuItem>
  );
}

/**
 * Pending run banner
 *
 * The editor's banner while an agent asks to run this community project: the agent never runs someone else's code
 * on its own, so the user presses Run here, or Don't run.
 */
export function PendingRunBanner({ projectId }: { projectId: string }) {
  const runs = usePendingRuns();

  return runs.some((run) => run.projectId === projectId) ? <ConnectedRunBanner projectId={projectId} /> : null;
}

function ConnectedRunBanner({ projectId }: { projectId: string }) {
  const connect = useConnect();
  const agent = useLastAgent(connect.status);
  const run = connect.pendingRuns.find((item) => item.projectId === projectId);

  if (run === undefined) {
    return null;
  }

  return (
    <div
      role="alertdialog"
      aria-label="Run request"
      className="flex shrink-0 items-center gap-2 border-b border-border bg-mark py-0 pr-2 pl-3 text-[12.5px] max-phone:flex-wrap max-phone:py-2"
      data-slot="pending-run-banner"
    >
      <ShieldAlertIcon className="size-4 shrink-0 stroke-[2.2]" aria-hidden="true" />
      <span className="flex min-h-11 min-w-0 flex-1 items-center">
        <span>
          <b className="font-semibold">{agent ?? "The agent"} wants to run this Community project.</b>{" "}
          <span className="text-muted">Its code was written by someone else. Run it only if you read it.</span>
        </span>
      </span>
      <Button variant="outline" className="h-7 min-h-7 px-2.5 text-[12.5px]" onClick={() => connect.declineRun(run.id)}>
        Don't run
      </Button>
      <Button variant="sticker" className="h-7 min-h-7 px-2.5 text-[12.5px]" onClick={() => connect.confirmRun(run.id)}>
        Run
      </Button>
    </div>
  );
}

/** The editor's banner while an agent edit of this project waits: "Claude Code edited query.ts +8 −3". */
export function PendingEditBanner({ projectId }: { projectId: string }) {
  const edits = usePendingEdits();

  return edits.some((edit) => edit.projectId === projectId) ? <ConnectedBanner projectId={projectId} /> : null;
}

function ConnectedBanner({ projectId }: { projectId: string }) {
  const connect = useConnect();
  const agent = useLastAgent(connect.status);
  const edit = connect.pendingEdits.filter((item) => item.projectId === projectId).at(-1);

  if (edit === undefined) {
    return null;
  }

  const refused = connect.undoError(edit.id);

  return (
    <div
      className="flex shrink-0 flex-col border-b border-border bg-mark text-[12.5px]"
      data-slot="pending-edit-banner"
    >
      <output className="flex h-11 items-center gap-2 py-0 pr-2 pl-3">
        <b className="font-semibold whitespace-nowrap">{agent ?? "The agent"} edited</b>
        <span className="min-w-0 truncate">
          <EditSummary edit={edit} />
        </span>
        <Chip tone="undone" className="bg-surface shadow-[0_0_0_1px_var(--border)]">
          pending
        </Chip>
        <span className="flex-1" />
        <EditDecisionButtons
          undoState={connect.undoState(edit.id)}
          onKeep={() => connect.keep(edit.id)}
          onUndo={() => connect.undo(edit.id)}
        />
      </output>
      {refused && (
        <p role="alert" className="m-0 px-3 pb-2 text-[12px] text-err">
          Undo was refused: {refused}
        </p>
      )}
    </div>
  );
}

/** Files of a project an agent edit changed and the user has not kept or undone. */
export function usePendingPaths(projectId: string): ReadonlySet<string> {
  const edits = usePendingEdits();

  return useMemo(
    () =>
      new Set(
        edits.filter((edit) => edit.projectId === projectId).flatMap((edit) => edit.files.map((file) => file.path)),
      ),
    [edits, projectId],
  );
}
