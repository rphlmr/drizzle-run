import { CONNECT_LOCAL_COMMAND, type AgentId, type CompanionInfo } from "@drizzle-run/core/connect";
import type { PendingEdit } from "@drizzle-run/runtime/machines";
import { ArrowUpIcon, ChevronDownIcon, CircleHelpIcon, ExternalLinkIcon, LockIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../components/ui/popover";
import { cn } from "../lib/utils";
import { ChatMarkdown } from "./chat-markdown";
import {
  sumEditCounts,
  type ChatChip,
  type ChatItem,
  type ChatTone,
  type QuotaLine as QuotaLineView,
} from "./chat-view";
import { useRevealedText } from "./use-revealed-text";

export const toneDot: Readonly<Record<ChatTone, string>> = {
  ok: "bg-ok",
  warn: "bg-warn",
  err: "bg-err",
  faint: "bg-faint",
};

/** A status dot in the tone's color. */
export function Dot({ tone, className }: { tone: ChatTone; className?: string }) {
  return <span aria-hidden="true" className={cn("size-1.75 shrink-0 rounded-full", toneDot[tone], className)} />;
}

const titleClass = cn("m-0 font-display text-[22px]/[1.15] font-[750] tracking-[-0.02em]");
const copyClass = cn("m-0 text-[13px] leading-[1.55] text-muted");
const smallCopyClass = cn("m-0 text-[12px] leading-[1.5] text-muted");
const smallButtonClass = cn("h-7 min-h-7 px-2.5 text-[12px]");
const cardClass = cn("rounded-[12px] border border-border bg-surface p-3");
const stickerCardClass = cn(
  "flex flex-col gap-2 rounded-[12px] border-[1.5px] border-card-border bg-surface p-3 shadow-sticker-card",
);

/** The companion's npm page, where the setup steps link. */
export const AGENT_LINK = "https://www.npmjs.com/package/@drizzle-run/connect";

/** Copies the text and says "Copied" for a moment. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }

    const timer = window.setTimeout(() => setCopied(false), 2000);

    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      variant="outline"
      className={smallButtonClass}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => undefined,
        );
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/**
 * The companion command on the terminal look, the pairing code in lime. On a local server it is
 * the checkout's own build, since the package may not be published, so a note says where to run it.
 */
export function CommandBox({ command, secret }: { command: string; secret?: string }) {
  const at = secret === undefined ? -1 : command.indexOf(secret);
  const local = command.startsWith(CONNECT_LOCAL_COMMAND);

  return (
    <>
      <CommandLine command={command} secret={secret} at={at} />
      {local && (
        <p className={cn(smallCopyClass, "mt-2")} data-slot="local-command">
          Local server: run it from the root of your Drizzle Run checkout.{" "}
          <code className="font-mono text-[11px]">pnpm dev</code> builds it.
        </p>
      )}
    </>
  );
}

function CommandLine({ command, secret, at }: { command: string; secret: string | undefined; at: number }) {
  return (
    <div
      className="flex items-start gap-1.5 rounded-base border border-border bg-term py-1 pr-1 pl-2.5 text-term-fg"
      data-slot="command"
    >
      <code className="min-w-0 flex-1 pt-1.5 font-mono text-[12px]/4.25 wrap-anywhere">
        {at === -1 || secret === undefined ? (
          command
        ) : (
          <>
            {command.slice(0, at)}
            <b className="font-semibold text-lime">{secret}</b>
            {command.slice(at + secret.length)}
          </>
        )}
      </code>
      <CopyButton text={command} />
    </div>
  );
}

function StepNumber({ children }: { children: ReactNode }) {
  return (
    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-ink text-[11px] font-bold text-lime">
      {children}
    </span>
  );
}

function Waiting({ children = "Waiting for the companion" }: { children?: ReactNode }) {
  return (
    <output className="mt-2.5 flex items-center gap-2 text-[12.5px] text-muted">
      <span
        aria-hidden="true"
        className="size-2 shrink-0 animate-pulse rounded-full bg-accent-text motion-reduce:animate-none"
      />
      {children}
    </output>
  );
}

function ForgetRow({ onForget }: { onForget: () => void }) {
  return (
    <div className="flex items-center gap-2 border-t border-border pt-3 text-[12px] text-muted">
      <span className="flex-1">Paired with this computer</span>
      <Button variant="outline" className={smallButtonClass} onClick={onForget}>
        Forget this computer
      </Button>
    </div>
  );
}

const bodyClass = cn("flex flex-col gap-3.5 px-4 py-5");

/**
 * ChatSetup: run the command, keep the tab open
 *
 * Without a command, it waits for the link code, or offers a new one through `onNewCode`, after `error` when making
 * the last one failed.
 */
export function SetupBody({
  command,
  secret,
  error,
  onNewCode,
}: {
  command: string | undefined;
  secret: string | undefined;
  error?: string;
  onNewCode?: () => void;
}) {
  return (
    <div className={bodyClass}>
      <h2 className={titleClass}>Chat with your coding agent</h2>
      <p className={copyClass}>
        Use Claude Code, Codex or Grok with your own subscription. It reads this project, edits it, and runs it here.
        Nothing else on your computer.
      </p>
      <div className={cardClass}>
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <StepNumber>1</StepNumber>Run this in a terminal
        </div>
        <div className="mt-2.5">
          {command === undefined ? (
            onNewCode ? (
              <div className="flex flex-col items-start gap-2">
                {error !== undefined && (
                  <p role="alert" className="m-0 text-[12px] leading-[1.45] wrap-anywhere text-err">
                    Could not make a link code. {error}
                  </p>
                )}
                <Button variant="outline" className={smallButtonClass} onClick={onNewCode}>
                  {error === undefined ? "New link code" : "Try again"}
                </Button>
              </div>
            ) : (
              <Waiting>Making a link code</Waiting>
            )
          ) : (
            <CommandBox command={command} secret={secret} />
          )}
        </div>
        <p className={cn(smallCopyClass, "mt-2")}>
          The code at the end links this browser to your computer, so keep it to yourself. Needs Node.js, and Claude
          Code, Codex or Grok installed and signed in.
        </p>
      </div>
      <div className={cardClass}>
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <StepNumber>2</StepNumber>Keep this tab open
        </div>
        <Waiting />
      </div>
      <p className={smallCopyClass} data-slot="one-command">
        Run it once: it serves every Drizzle Run tab in this browser, and a tab you open later joins on its own. Each
        project keeps its own chat, and no chat sees another's.
      </p>
      <p role="note" className="m-0 rounded-md bg-mark px-3 py-2.5 text-[12px] leading-normal">
        Works in every browser. Your chat is encrypted on your computer and in this tab, so drizzle.run passes it along
        without reading it.
      </p>
      <a href={AGENT_LINK} target="_blank" rel="noreferrer" className="text-[12.5px] font-semibold text-accent-text">
        What the agent can and can't do
      </a>
    </div>
  );
}

/** ChatPair: the companion linked the tab; pick the agent. */
export function PairBody({
  companion,
  command,
  rejoin,
  onStart,
  onCancel,
}: {
  companion: CompanionInfo;
  command: string;
  rejoin: string;
  onStart: (agent: AgentId) => void;
  onCancel: () => void;
}) {
  const [picked, setPicked] = useState<AgentId | undefined>(companion.agents[0]?.id);
  const chosen = companion.agents.some((agent) => agent.id === picked) ? picked : companion.agents[0]?.id;

  return (
    <div className={bodyClass}>
      <h2 className={titleClass}>Companion connected</h2>
      <p className={copyClass}>Your terminal linked this browser. Pick the agent you want to chat with.</p>
      <figure
        className="rounded-md border border-border bg-term px-3 py-2.5 font-mono text-[11.5px]/4.75 wrap-anywhere text-term-fg"
        aria-label="Your terminal"
      >
        <div>
          <span className="text-term-dim">$</span> {command}
        </div>
        <div>Drizzle Run connect</div>
        <div>
          <span className="text-term-dim">Linked to</span> your drizzle.run tabs, encrypted
        </div>
        <div>
          <span className="text-term-dim">Agents found:</span>{" "}
          {companion.agents.map((agent) => agent.name).join(", ") || "none"}
        </div>
        <div>
          <span className="text-term-dim">Pairing saved. Next time:</span>{" "}
          <b className="font-semibold text-lime">{rejoin}</b>
        </div>
      </figure>
      {companion.agents.length === 0 ? (
        <p className={copyClass}>
          No agent was found on this computer. Install Claude Code, Codex or Grok, sign in, then start the companion
          again.
        </p>
      ) : (
        <fieldset className="m-0 grid gap-1.5 border-0 p-0">
          <legend className="mb-1.5 p-0 text-[12px] font-semibold text-muted">Chat with</legend>
          {companion.agents.map((agent) => (
            <label
              key={agent.id}
              className={cn(
                "flex min-h-10 cursor-pointer items-center gap-2.5 rounded-md border bg-surface px-3 text-[13px]",
                chosen === agent.id ? "border-card-border" : "border-border",
              )}
            >
              <input
                type="radio"
                name="agent"
                className="m-0 accent-(--accent-text)"
                checked={chosen === agent.id}
                onChange={() => setPicked(agent.id)}
              />
              <b className="font-semibold">{agent.name}</b>
              <span className="ml-auto text-[11.5px] text-muted">found</span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex gap-2">
        <Button
          variant="sticker"
          className="h-9 px-4"
          disabled={chosen === undefined}
          onClick={() => chosen && onStart(chosen)}
        >
          Start chat
        </Button>
        <Button variant="outline" className="h-9" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <p className={smallCopyClass}>
        Each tab's chat sees and runs its own project only, in its own agent session. It can't share, publish, or open
        other files. Tabs you open later join on their own; this browser and your computer remember the pairing until
        you forget it.
      </p>
    </div>
  );
}

/** ChatReturn: paired before; start the companion again. */
export function ReturnBody({
  command,
  projectName,
  onForget,
}: {
  command: string;
  projectName: string;
  onForget: () => void;
}) {
  return (
    <div className={bodyClass}>
      <h2 className={titleClass}>Start the companion</h2>
      <p className={copyClass}>
        This browser is paired with your computer. Start the companion once and every Drizzle Run tab here reconnects on
        its own.
      </p>
      <div className={cardClass}>
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <StepNumber>1</StepNumber>Run this in a terminal
        </div>
        <div className="mt-2.5">
          <CommandBox command={command} />
        </div>
      </div>
      <div className={cardClass}>
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <StepNumber>2</StepNumber>Keep this tab open
        </div>
        <Waiting />
      </div>
      <p className={smallCopyClass}>
        Your chat about {projectName} is kept. Each project keeps its own chat in this browser.
      </p>
      <ForgetRow onForget={onForget} />
    </div>
  );
}

/** The user disconnected this tab, with no chat yet; the pairing stays. */
export function OffBody({ onReconnect, onForget }: { onReconnect: () => void; onForget: () => void }) {
  return (
    <div className={bodyClass}>
      <h2 className={titleClass}>Disconnected</h2>
      <p className={copyClass}>
        This tab left the companion. The pairing stays, so Reconnect links it again while the companion runs.
      </p>
      <div>
        <Button variant="outline" className={smallButtonClass} onClick={onReconnect}>
          Reconnect
        </Button>
      </div>
      <ForgetRow onForget={onForget} />
    </div>
  );
}

/** The companion speaks another protocol version. */
export function IncompatibleBody({ command, onForget }: { command: string; onForget: () => void }) {
  return (
    <div className={bodyClass}>
      <h2 className={titleClass}>Update the companion</h2>
      <p className={copyClass}>
        The companion on your computer is a different version than this tab. Stop it, then run the latest one.
      </p>
      <CommandBox command={command} />
      <ForgetRow onForget={onForget} />
    </div>
  );
}

/** The panel while the companion forgets this computer's pairing. */
export function ForgettingBody() {
  return (
    <div className={bodyClass}>
      <h2 className={titleClass}>Forgetting this computer</h2>
      <Waiting>Telling the companion to forget the pairing</Waiting>
    </div>
  );
}

/** ChatReady: nothing said yet. */
export function EmptyBody({
  projectName,
  agent,
  files,
  suggestions,
  onSuggestion,
  onForget,
}: {
  projectName: string;
  agent: string;
  files: readonly string[];
  suggestions: readonly string[];
  onSuggestion: (text: string) => void;
  onForget: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-5.5">
      <h2 className={titleClass}>Ask about {projectName}</h2>
      <p className={copyClass}>
        {agent} sees{" "}
        {files.length > 0 ? `${files.join(", ")}, and your latest run` : "this project and your latest run"}. Runs it
        starts show up in Results, like yours.
      </p>
      <div className="grid gap-1.5">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            className="min-h-10 cursor-pointer rounded-md border border-border bg-surface px-3 py-2.25 text-left text-[13px] leading-[1.4] text-text hover:border-muted"
            onClick={() => onSuggestion(suggestion)}
          >
            {suggestion}
          </button>
        ))}
      </div>
      <p className={smallCopyClass}>
        Each project keeps its own chat in this browser. Open another project and the agent follows it.
      </p>
      <ForgetRow onForget={onForget} />
    </div>
  );
}

const chipTones: Readonly<Record<ChatChip, string>> = {
  pending: "bg-mark text-accent-text",
  kept: "bg-ok-bg text-ok",
  undone: "bg-surface-2 text-muted",
  "rolled back": "bg-err-bg text-err",
};

/** A small pill in a chat row: pending, kept, undone, or rolled back on a run. */
export function Chip({ tone, children, className }: { tone: ChatChip; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.25 rounded-pill px-2 text-[11px] font-semibold whitespace-nowrap",
        chipTones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * A tool call: "Read · query.ts · 15 lines", with a spinner while it runs. A docs call always opens
 * to its link; a call whose target is cut off or that failed opens to the full target and the error.
 */
export function ToolRow({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const [expanded, setExpanded] = useState(false);
  const [summary, summaryCut] = useTruncated();
  const expandable = item.error !== undefined || item.link !== undefined || (summaryCut && item.target !== undefined);
  const head = (
    <>
      {item.spinning ? (
        <span className="size-3 animate-spin justify-self-center rounded-full border-2 border-border border-t-text motion-reduce:animate-none">
          <span className="sr-only">Running</span>
        </span>
      ) : (
        <span aria-hidden="true" className={cn("size-2 justify-self-center rounded-full", toneDot[item.tone])} />
      )}
      <span ref={summary} className="min-w-0 truncate">
        <b className="font-semibold">{item.label}</b>
        {item.target && (
          <>
            {" "}
            <span className="font-mono text-[11.5px] text-muted">{item.target}</span>
          </>
        )}
      </span>
      <span className="inline-flex items-center gap-1.5 text-[11.5px] whitespace-nowrap text-muted">
        {item.meta && <span className="font-mono text-[11px]">{item.meta}</span>}
        {item.chip && <Chip tone={item.chip}>{item.chip}</Chip>}
        {expandable && (
          <ChevronDownIcon
            className={cn(
              "size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
              expanded && "rotate-180",
            )}
            aria-hidden="true"
          />
        )}
      </span>
    </>
  );
  const headClass = "grid min-h-8 w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-2 px-2.5 text-left";

  return (
    <div className="rounded-md border border-border bg-surface text-[12.5px]" data-slot="tool-row">
      {expandable ? (
        <button
          type="button"
          aria-expanded={expanded}
          className={cn(headClass, "cursor-pointer rounded-md border-0 bg-transparent text-text")}
          onClick={() => setExpanded((open) => !open)}
        >
          {head}
        </button>
      ) : (
        <div className={headClass}>{head}</div>
      )}
      {expandable && expanded && (
        <div
          className="flex flex-col gap-1 border-t border-border py-2 pr-2.5 pl-9.5 leading-normal"
          data-slot="tool-details"
        >
          {item.target &&
            (item.link ? (
              <a
                href={item.link}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[11.5px] wrap-anywhere text-accent-text"
              >
                {item.link}
              </a>
            ) : (
              <span className="font-mono text-[11.5px] wrap-anywhere text-muted">{item.target}</span>
            ))}
          {item.error && <span className="wrap-anywhere text-err">{item.error}</span>}
        </div>
      )}
      {item.opens && (
        <a
          href={item.opens.href}
          target="_blank"
          rel="noopener"
          className="flex min-h-9 items-center gap-2 border-t border-border px-2.5 text-text no-underline hover:bg-surface-2"
          data-slot="project-link"
        >
          <ExternalLinkIcon className="size-3.5 shrink-0 text-accent-text" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-semibold">Open {item.opens.name}</span>
          <span className="text-[11.5px] whitespace-nowrap text-muted">New tab</span>
        </a>
      )}
    </div>
  );
}

/** A ref for an element whose text may be cut by `truncate`, and whether it is cut now. */
function useTruncated(): [(element: HTMLElement | null) => void, boolean] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    if (element === null) {
      return;
    }

    const measure = () => setTruncated(element.scrollWidth > element.clientWidth);
    const observer = new ResizeObserver(measure);

    observer.observe(element);
    measure();

    return () => observer.disconnect();
  }, [element]);

  return [setElement, truncated];
}

/** Asks before an agent edits in Ask mode: Allow or Dismiss. */
export function AskCard({
  target,
  agent,
  onAllow,
  onDismiss,
}: {
  target: string | undefined;
  agent: string;
  onAllow: () => void;
  onDismiss: () => void;
}) {
  return (
    <fieldset className={cn(stickerCardClass, "min-w-auto")} aria-label="Edit request">
      <b className="text-[13px] font-[650]">{target ? `This needs an edit to ${target}` : "This needs an edit"}</b>
      <span className="text-[12.5px] leading-normal text-muted">
        You're in Ask mode: {agent} can read and run this project, not change it.
      </span>
      <div className="flex flex-wrap gap-2">
        <Button variant="sticker" className="h-7.5 min-h-7.5 px-2.5 text-[12.5px]" onClick={onAllow}>
          Allow edits in this chat
        </Button>
        <Button variant="outline" className="h-7.5 min-h-7.5 px-2.5 text-[12.5px]" onClick={onDismiss}>
          Not now
        </Button>
      </div>
    </fieldset>
  );
}

/** Under the last row while the agent works without a running tool: a pulsing dot and "Thinking". */
function Thinking({ agent }: { agent: string }) {
  return (
    <output className="flex items-center gap-2 px-0.5 text-[12px] text-muted" aria-label={`${agent} is thinking`}>
      <span
        aria-hidden="true"
        className="size-2 shrink-0 animate-pulse rounded-full bg-accent-text motion-reduce:animate-none"
      />
      Thinking
    </output>
  );
}

/**
 * An agent's answer. The streaming one reveals word by word; `resumed` shows what it had when the chat opened at once.
 */
function AgentMessage({
  text,
  streaming,
  resumed,
  className,
}: {
  text: string;
  streaming: boolean;
  resumed: boolean;
  className: string;
}) {
  const revealed = useRevealedText({ text, streaming, resumed });

  if (revealed === "") {
    return null;
  }

  return (
    <div className={cn("px-0.5 leading-[1.55] wrap-anywhere", className)} data-slot="agent-message">
      <ChatMarkdown text={revealed} streaming={streaming} />
    </div>
  );
}

/** Render chat rows at the dock or guide rail's text size. */
export function ChatMessages({
  items,
  agent,
  guided = false,
  onAllow,
  onDismiss,
}: {
  items: readonly ChatItem[];
  agent: string;
  guided?: boolean;
  onAllow?: (toolId: string) => void;
  onDismiss?: (toolId: string) => void;
}) {
  const text = guided ? "text-[14px]" : "text-[13px]";
  const [openedKeys] = useState(() => new Set(items.map((item) => item.key)));

  return (
    <>
      {items.map((item) => {
        switch (item.kind) {
          case "user":
            return (
              <div
                key={item.key}
                className={cn(
                  "max-w-[88%] self-end rounded-[12px_12px_4px_12px] bg-surface-2 px-3 py-2.25 leading-normal wrap-anywhere whitespace-pre-wrap",
                  text,
                )}
                data-slot="user-message"
              >
                {item.text}
              </div>
            );
          case "say":
            return (
              <AgentMessage
                key={item.key}
                text={item.text}
                streaming={item.streaming}
                resumed={openedKeys.has(item.key)}
                className={text}
              />
            );
          case "tool":
            return <ToolRow key={item.key} item={item} />;
          case "ask":
            return onAllow && onDismiss ? (
              <AskCard
                key={item.key}
                target={item.target}
                agent={agent}
                onAllow={() => onAllow(item.toolId)}
                onDismiss={() => onDismiss(item.toolId)}
              />
            ) : null;
          case "allowed":
            return (
              <output key={item.key} className="flex items-center gap-2 px-0.5 text-[12px] text-muted">
                <span className="font-bold text-ok" aria-hidden="true">
                  ✓
                </span>
                Edits allowed in this chat. Each one still waits for Keep or Undo.
              </output>
            );
          case "thinking":
            return <Thinking key={item.key} agent={agent} />;
          case "notice":
            return (
              <p
                key={item.key}
                className={cn("m-0 px-0.5 text-[12px]", item.tone === "err" ? "text-err" : "text-muted")}
                role={item.tone === "err" ? "alert" : undefined}
              >
                {item.text}
              </p>
            );
        }
      })}
    </>
  );
}

/** Says the companion stopped, with the command that starts it again. */
export function StoppedBanner({ command }: { command: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-[12px] border-[1.5px] border-dashed border-err bg-err-bg p-3">
      <output className="flex flex-col gap-2">
        <b className="text-[13px] font-[650] text-err">The companion stopped</b>
        <span className="text-[12.5px] leading-normal">
          Your chat stays in this tab. Start the companion again and this tab reconnects on its own.
        </span>
      </output>
      <CommandBox command={command} />
    </div>
  );
}

/** Under a chat the user disconnected: the chat stays, Reconnect links the tab again. */
export function OffBanner({ onReconnect }: { onReconnect: () => void }) {
  return (
    <output className={cn(cardClass, "flex flex-col items-start gap-2")}>
      <b className="text-[13px] font-[650]">You disconnected this tab</b>
      <span className="text-[12.5px] leading-normal text-muted">
        Your chat stays in this tab, and the pairing too. Reconnect while the companion runs to go on.
      </span>
      <Button variant="outline" className={smallButtonClass} onClick={onReconnect}>
        Reconnect
      </Button>
    </output>
  );
}

/** Says the chat link reached today's limit, and when it opens again. */
export function BusyCard({ time }: { time: string }) {
  return (
    <output className={cn(stickerCardClass, "gap-1.5")}>
      <b className="text-[13px] font-[650]">AI chat is busy right now</b>
      <span className="text-[12.5px] leading-normal text-muted">
        Drizzle Run's chat link reached today's limit. Your chat and the companion stay as they are. Try again after{" "}
        {time}, your time.
      </span>
    </output>
  );
}

/** Under a chat whose connection the relay refused: too many from this network, so the tab waits and tries again. */
export function LimitedCard() {
  return (
    <output className={cn(stickerCardClass, "gap-1.5")}>
      <b className="text-[13px] font-[650]">Too many AI chat connections</b>
      <span className="text-[12.5px] leading-normal text-muted">
        Your network opened a lot of chat connections in the last minute. Your chat stays, and this tab reconnects on
        its own shortly.
      </span>
    </output>
  );
}

/**
 * Terminal note
 *
 * Says the chat happens in the terminal while a terminal agent works, and warns that the agent there keeps its own
 * shell, files and network while it reads this project: a project's content can try to steer it.
 */
export function TerminalNote({ community = false }: { community?: boolean }) {
  return (
    <>
      <p className="m-0 rounded-md bg-mark px-3 py-2.5 text-[12.5px] leading-normal">
        You chat in your terminal. What it reads, runs, and edits shows up here, and edits still wait for Keep.
      </p>
      <div role="note" className={cn(stickerCardClass, "gap-1.5 border-warn")} data-slot="terminal-warning">
        <b className="text-[13px] font-[650]">Your terminal agent keeps all of its tools</b>
        <span className="text-[12.5px] leading-normal text-muted">
          {community
            ? "This project comes from the Community. "
            : "A project's files and output can be written by anyone who shared it. "}
          Text in them may try to make your agent run commands, read files, or send data from your computer. Drizzle Run
          marks it as data, but only your agent decides. For projects you did not write, prefer the chat here, which
          gives the agent nothing but Drizzle Run.
        </span>
      </div>
    </>
  );
}

/** Says a chat's project is someone else's: the agent reads its content as data, and a run waits for the user. */
export function CommunityNote() {
  return (
    <p
      role="note"
      className="m-0 rounded-md bg-mark px-3 py-2.5 text-[12.5px] leading-normal"
      data-slot="community-note"
    >
      <b className="font-semibold">Community project.</b> Its code and output were written by someone else and may try
      to steer the agent. The agent reads them as data, and asks you before it runs anything.
    </p>
  );
}

/** Says why the chat on a shared link reads only: someone else wrote it. */
export function SharedLinkNote() {
  return (
    <p
      role="note"
      className="m-0 rounded-md bg-mark px-3 py-2.5 text-[12.5px] leading-normal"
      data-slot="read-only-note"
    >
      <b className="font-semibold">AI can only read this.</b> Someone else wrote it. Fork it to keep a copy.
    </p>
  );
}

/** Says why the chat on an untrusted fork reads only, with the user's way to trust it. */
export function UntrustedNote({ onTrust }: { onTrust: () => void }) {
  return (
    <div
      role="note"
      className="flex flex-col items-start gap-2 rounded-md bg-mark px-3 py-2.5 text-[12.5px] leading-normal"
      data-slot="read-only-note"
    >
      <p className="m-0">
        <b className="font-semibold">AI can only read this.</b> Someone else wrote it.
      </p>
      <Button variant="outline" className={smallButtonClass} onClick={onTrust}>
        Allow AI edits
      </Button>
    </div>
  );
}

/** The edit's files and line counts: "query.ts +8 −3". */
export function EditSummary({ edit }: { edit: PendingEdit }) {
  const counts = sumEditCounts(edit.files);

  return (
    <>
      <span className="font-mono text-[11.5px] text-muted">{edit.files.map((file) => file.path).join(", ")}</span>{" "}
      {edit.where !== undefined && <span className="text-[11.5px] text-muted">on {edit.where} </span>}
      <span className="font-mono text-[11.5px]">
        <span className="text-ok">+{counts.added}</span> <span className="text-err">−{counts.removed}</span>
      </span>
    </>
  );
}

/** Where a pending edit's Undo is, as `useConnect().undoState` reads it. */
export type UndoState = "queued" | "running" | undefined;

/**
 * Undo and Keep for a pending edit
 *
 * While its Undo waits behind another job or puts files back, Undo reads "Undoing…" and is off. Keep stays on while
 * the Undo waits, since it cancels it, and is off while files go back.
 */
export function EditDecisionButtons({
  undoState,
  onKeep,
  onUndo,
}: {
  undoState: UndoState;
  onKeep: () => void;
  onUndo: () => void;
}) {
  return (
    <>
      <Button
        variant="outline"
        className="h-7 min-h-7 px-2.5 text-[12.5px]"
        disabled={undoState !== undefined}
        onClick={onUndo}
      >
        {undoState === undefined ? "Undo" : "Undoing…"}
      </Button>
      <Button
        variant="sticker"
        className="h-7 min-h-7 px-2.5 text-[12.5px]"
        disabled={undoState === "running"}
        onClick={onKeep}
      >
        Keep
      </Button>
    </>
  );
}

/** The edits waiting for Keep or Undo, with their line counts. */
export function PendingBar({
  edits,
  error,
  undoState,
  onKeep,
  onUndo,
}: {
  edits: readonly PendingEdit[];
  error: (id: string) => string | undefined;
  undoState: (id: string) => UndoState;
  onKeep: (id: string) => void;
  onUndo: (id: string) => void;
}) {
  return (
    <>
      {edits.map((edit) => {
        const refused = error(edit.id);

        return (
          <div
            key={edit.id}
            className="mx-3 mb-2.5 flex shrink-0 flex-col gap-1.5 rounded-[12px] border-[1.5px] border-card-border bg-surface py-2 pr-2 pl-3 text-[12.5px] shadow-sticker-card"
            data-slot="pending-bar"
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">
                <b className="font-semibold">{edits.length === 1 ? "1 pending edit" : "Pending edit"}</b>{" "}
                <EditSummary edit={edit} />
              </span>
              <EditDecisionButtons
                undoState={undoState(edit.id)}
                onKeep={() => onKeep(edit.id)}
                onUndo={() => onUndo(edit.id)}
              />
            </div>
            {refused && (
              <p role="alert" className="m-0 text-[12px] leading-[1.45] text-err">
                Undo was refused: {refused}
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}

function sendOnEnter(event: KeyboardEvent<HTMLTextAreaElement>, send: () => void) {
  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
    event.preventDefault();
    send();
  }
}

/** Sends the composer's message. */
export function SendButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <Button
      variant="sticker"
      className="h-7.5 min-h-7.5 w-8 px-0"
      aria-label="Send"
      disabled={disabled}
      onClick={onClick}
    >
      <ArrowUpIcon className="size-3.5 stroke-[2.6]" aria-hidden="true" />
    </Button>
  );
}

/** Stops the agent's turn. */
export function StopButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="outline"
      className="h-7.5 min-h-7.5 px-2.5 text-[12.5px] font-semibold"
      aria-label="Stop the agent"
      onClick={onClick}
    >
      <span aria-hidden="true" className="size-2.25 rounded-[2px] bg-current" />
      Stop
    </Button>
  );
}

/** The textarea and its row, in a card-bordered box. The caller owns the draft. */
export function Composer({
  draft,
  onDraft,
  placeholder,
  disabled,
  label,
  height,
  fontSize,
  footer,
  onSend,
  inputRef,
}: {
  draft: string;
  onDraft: (text: string) => void;
  placeholder: string;
  disabled: boolean;
  label: string;
  height: string;
  fontSize: string;
  footer: ReactNode;
  onSend: () => void;
  inputRef?: React.Ref<HTMLTextAreaElement>;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[12px] border-[1.5px] border-card-border bg-surface has-[textarea:focus-visible]:border-accent-text",
        disabled && "opacity-55",
      )}
    >
      <textarea
        ref={inputRef}
        aria-label={label}
        placeholder={placeholder}
        disabled={disabled}
        value={draft}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={(event) => sendOnEnter(event, onSend)}
        className={cn(
          "block w-full resize-none rounded-t-[10.5px] border-0 bg-transparent px-3 pt-2.5 leading-[1.45] text-text placeholder:text-faint focus-visible:outline-transparent disabled:cursor-not-allowed",
          height,
          fontSize,
        )}
      />
      <div className="flex items-center gap-1.5 py-1.5 pr-1.5 pl-2">{footer}</div>
    </div>
  );
}

/**
 * Read-only mode
 *
 * The small line above a guide's composer: the agent only answers during a guide. The (?) opens what
 * that means.
 */
export function ReadOnlyModeLine() {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[11.5px] text-muted" data-slot="read-only-mode">
      <LockIcon className="size-3 shrink-0 stroke-[2.2]" aria-hidden="true" />
      <span>Read-only mode</span>
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label="What read-only mode means"
              className="inline-flex size-4 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted hover:text-text"
            />
          }
        >
          <CircleHelpIcon className="size-3.5" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="max-w-70 p-3 text-[12.5px] leading-normal text-muted">
          <PopoverTitle className="mb-1 text-[12.5px] font-semibold text-text">Read-only mode</PopoverTitle>
          During a guide the agent reads this step, the code, the last run and the docs. It never edits or runs: you
          press Run, so the guide moves at your pace.
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** How much of today's AI chat this tab's share has used, with a "?" that says what the limit is. */
export function QuotaLine({ line }: { line: QuotaLineView }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted" data-slot="chat-quota">
      <span className="truncate">{line.text}</span>
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label="What the daily AI chat limit is"
              className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted hover:text-text"
            />
          }
        >
          <CircleHelpIcon className="size-3.5" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="max-w-70 p-3 text-[12.5px] leading-normal text-muted">
          <PopoverTitle className="mb-1 text-[12.5px] font-semibold text-text">Daily AI chat limit</PopoverTitle>
          To keep Drizzle Run free, each {line.holder} gets a daily amount of AI chat. It resets at {line.resetTime},
          your time. Your link code and messages stay end-to-end encrypted.
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * Keeps a message list scrolled to its end as rows arrive, unless the reader scrolled up.
 *
 * It checks after every render: at the end already, scrolling again is a no-op, so only grown content moves. A
 * streaming answer reveals inside its own row without rendering the list, so a change anywhere in the list checks too.
 */
export function useStickToBottom() {
  const scroller = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const attachScroller = useCallback((element: HTMLDivElement | null) => {
    scroller.current = element;

    if (element === null) {
      return;
    }

    const observer = new MutationObserver(() => {
      if (pinned.current) {
        element.scrollTop = element.scrollHeight;
      }
    });

    observer.observe(element, { childList: true, subtree: true, characterData: true });

    return () => {
      observer.disconnect();
      scroller.current = null;
    };
  }, []);

  useEffect(() => {
    const element = scroller.current;

    if (element !== null && pinned.current) {
      element.scrollTop = element.scrollHeight;
    }
  });

  return {
    attachScroller,
    onScroll: () => {
      const element = scroller.current;

      if (element !== null) {
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }
    },
  };
}
