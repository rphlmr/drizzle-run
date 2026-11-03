import {
  CONNECT_LIMITS,
  connectTool,
  createPairingSecret,
  isToolInScope,
  parseToolInput,
  RELAY_CLOSE,
  fitAgentTuning,
  scopeRefusal,
  type AgentId,
  type AgentTuning,
  type ChatMode,
  type CompanionInfo,
  type ConnectToolName,
  type RelayBusyFrame,
  type RelayQuotaFrame,
  type ToolError,
} from "@drizzle-run/core/connect";
import { omit, uniq } from "es-toolkit";
import { assign, emit, enqueueActions, fromPromise, raise, sendTo, setup, type SnapshotFrom } from "xstate";

import { createEditStoreLogic, createJobsMachine, createLinkMachine, LINK_ID } from "./connect-actors.ts";
import type {
  CompanionMessage,
  ConnectActivity,
  ConnectChat,
  ConnectContext,
  ConnectEmitted,
  ConnectEvent,
  ConnectOpenProject,
  ConnectPairing,
  ConnectServices,
  ConnectToolOutcome,
  ConnectToolRequest,
  ConnectToolSummary,
  EditDecision,
  EditStoreCommand,
  InternalEvent,
  Job,
  LinkCommand,
  PendingEdit,
  PendingRun,
} from "./connect-contract.ts";
import { declareType } from "./declare-type.ts";
import { getErrorText } from "./error-text.ts";

/**
 * The tab's side of the AI chat link (`@drizzle-run/connect`): pairing and its memory, the
 * sealed WebSocket to the relay room, reconnects, the companion's hello and versions,
 * the chat stream, tool calls (checked here, executed by the host against the open
 * project), pending edits that wait for Keep or Undo, and agent runs of a community project
 * that wait for the user.
 *
 * Each chat keeps its own mode and the project its turns act on: a call from a chat whose
 * project is not open is refused, and leaving that project stops the chat's turn.
 *
 * Every side effect is injected: storage, the socket, tool execution, and undo.
 */

const MAX_ACTIVITY_ENTRIES = 500;
/**
 * The agent, model and effort a turn sends
 *
 * The chat's agent when the companion offers it, else the companion's choice; then the model and effort that agent
 * still offers (see `fitAgentTuning`).
 */
function getTurnAgent(
  companion: CompanionInfo | undefined,
  event: { agent?: AgentId; tuning?: AgentTuning },
): { agent?: AgentId } & AgentTuning {
  const agent =
    companion?.agents.find((offered) => offered.id === event.agent) ??
    companion?.agents.find((offered) => offered.id === companion.agent);

  if (agent === undefined) {
    return {};
  }

  return { agent: agent.id, ...(event.tuning === undefined ? {} : fitAgentTuning(agent, event.tuning)) };
}

/** A run request lapses before the companion's own 5 minute wait for the call does. */
const RUN_CONFIRM_TIMEOUT_MS = 240_000; // 4 minutes
const MAX_BACKOFF_MS = 30_000;
const FORGET_WAIT_MS = 3_000;

function withActivity(activity: readonly ConnectActivity[], entry: ConnectActivity) {
  return [...activity, entry].slice(-MAX_ACTIVITY_ENTRIES);
}

/** Merges streamed text into the turn's text entry, so a turn reads as one message. */
function withText(activity: readonly ConnectActivity[], entry: Extract<ConnectActivity, { kind: "text" }>) {
  const last = activity.at(-1);

  if (last?.kind === "text" && last.turn === entry.turn && last.conversation === entry.conversation) {
    return [...activity.slice(0, -1), { ...last, text: last.text + entry.text }];
  }

  return withActivity(activity, entry);
}

function withToolChange(
  activity: readonly ConnectActivity[],
  id: string,
  change: Partial<Extract<ConnectActivity, { kind: "tool" }>>,
) {
  return activity.map((entry) => (entry.kind === "tool" && entry.id === id ? { ...entry, ...change } : entry));
}

function withEditDecision(activity: readonly ConnectActivity[], editId: string, decision: EditDecision) {
  return activity.map((entry) =>
    entry.kind === "tool" && entry.edit?.id === editId ? { ...entry, edit: { id: editId, decision } } : entry,
  );
}

/**
 * What a forgotten pairing leaves: the chats, their rows, and the edits still waiting, with their Undo jobs, which
 * the jobs actor keeps running
 */
function keepAfterForget(context: ConnectContext): ConnectContext {
  return {
    ...createInitialContext(context.mode),
    chats: context.chats,
    activity: context.activity,
    pendingEdits: context.pendingEdits,
    queuedUndos: context.queuedUndos,
    runningUndo: context.runningUndo,
    dock: context.dock,
  };
}

/** The result's JSON length when it exceeds what one message carries, else `undefined`. */
function resolveOversizedLength(result: unknown): number | undefined {
  const resultLength = JSON.stringify(result ?? null).length;

  return resultLength > CONNECT_LIMITS.maxToolResultChars ? resultLength : undefined;
}

/** Whether a conversation's `create_project` call is running: its turn is about to follow the new project. */
function isCreatingProject(activity: readonly ConnectActivity[], conversation: string) {
  return activity.some(
    (entry) =>
      entry.kind === "tool" &&
      entry.conversation === conversation &&
      entry.name === "create_project" &&
      entry.status === "running",
  );
}

/** Chats with a turn in progress whose project is not the open one, and that are not creating a project. */
function findStrayChats(
  chats: Readonly<Record<string, ConnectChat>>,
  activity: readonly ConnectActivity[],
  open: ConnectOpenProject | undefined,
): string[] {
  return Object.entries(chats)
    .filter(
      ([conversation, chat]) =>
        chat.projectId !== open?.id &&
        workingTurn(activity, conversation) !== undefined &&
        !isCreatingProject(activity, conversation),
    )
    .map(([conversation]) => conversation);
}

/** What a settled tool call answers: its outcome, or a failure when its result is too large to carry. */
function resolveToolResult(outcome: ConnectToolOutcome): ConnectToolOutcome {
  const oversizedLength = outcome.ok ? resolveOversizedLength(outcome.result) : undefined;

  if (oversizedLength === undefined) {
    return outcome;
  }

  return {
    ok: false,
    error: {
      code: "failed",
      message:
        `The result has ${oversizedLength} characters, over the ${CONNECT_LIMITS.maxToolResultChars} ` +
        "a message carries. Ask for less, such as one file or one side.",
    },
  };
}

function getEditId(request: ConnectToolRequest) {
  return `edit-${request.id}`;
}

/** The `tool.result` the companion gets for a settled call. */
function toToolResultMessage(request: ConnectToolRequest, outcome: ConnectToolOutcome): CompanionMessage {
  const result = resolveToolResult(outcome);

  if (!result.ok) {
    return { type: "tool.result", id: request.id, ok: false, error: result.error };
  }

  return {
    type: "tool.result",
    id: request.id,
    ok: true,
    result: result.pendingEdit
      ? { ...toRecord(result.result), edit_id: getEditId(request), status: "pending" }
      : result.result,
  };
}

const UNANSWERED_TOOL_ERROR: ToolError = {
  code: "unavailable",
  message: "The companion that asked for this left before it got the result.",
};

function getBackoffMs(attempt: number) {
  return Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempt, 5));
}

function createInitialContext(mode: ChatMode = "ask"): ConnectContext {
  return {
    pairing: undefined,
    companion: undefined,
    peer: undefined,
    companionSeen: false,
    dock: "closed",
    mode,
    chats: {},
    busy: undefined,
    quota: undefined,
    incompatible: undefined,
    refusal: undefined,
    attempt: 0,
    error: "",
    activity: [],
    pendingEdits: [],
    queuedUndos: [],
    runningUndo: undefined,
    undoErrors: {},
    pendingRuns: [],
  };
}

/** Builds the tab's AI chat link with the host's services. */
export function createConnectMachine(services: ConnectServices) {
  const now = () => services.now?.() ?? Date.now();

  return setup({
    types: {
      context: declareType<ConnectContext>(),
      events: declareType<ConnectEvent | InternalEvent>(),
      emitted: declareType<ConnectEmitted>(),
    },
    actors: {
      loadPairing: fromPromise<ConnectPairing | undefined>(() => services.loadPairing()),
      createPairing: fromPromise<ConnectPairing>(async () => {
        const pairing: ConnectPairing = {
          secret: services.createSecret?.() ?? createPairingSecret(),
          pairedAt: new Date(now()).toISOString(),
        };

        await services.savePairing(pairing);

        return pairing;
      }),
      confirmPairing: fromPromise<ConnectPairing, ConnectPairing>(async ({ input }) => {
        const confirmed = { ...input, confirmedAt: new Date(now()).toISOString() };

        await services.savePairing(confirmed);

        return confirmed;
      }),
      clearPairing: fromPromise<void>(() => services.clearPairing()),
      restoreEdits: fromPromise<readonly PendingEdit[]>(async () => (await services.loadPendingEdits?.()) ?? []),
      link: createLinkMachine(services),
      jobs: createJobsMachine(services),
      editStore: createEditStoreLogic(services),
    },
    delays: {
      backoff: ({ context }) => getBackoffMs(context.attempt),
      untilRetry: ({ context }) => Math.max(1_000, Date.parse(context.busy?.retryAt ?? "") - now() || 0),
      forgetWait: FORGET_WAIT_MS,
    },
    guards: {
      hasPairing: ({ event }) => "output" in event && event.output !== undefined,
      chatReady: ({ context }) => context.companion?.mode === "chat" && context.companion.agent !== undefined,
      canChoose: ({ context, event }) =>
        event.type === "chat.agent.choose" &&
        context.companion?.mode === "chat" &&
        context.companion.agents.some((agent) => agent.id === event.agent),
      unconfirmed: ({ context }) => context.pairing !== undefined && context.pairing.confirmedAt === undefined,
      expired: ({ event }) =>
        event.type === "link.closed" && (event.code === RELAY_CLOSE.expired || event.code === RELAY_CLOSE.full),
      unproven: ({ event }) => event.type === "link.closed" && event.code === RELAY_CLOSE.unproven,
      rateLimited: ({ event }) => event.type === "link.closed" && event.code === RELAY_CLOSE.rateLimited,
      hasCompanion: ({ context }) => context.companion !== undefined,
      hasPeer: ({ context }) => context.peer !== undefined,
      isDockOpen: ({ context }) => context.dock === "open",
      isCallerLinked: ({ context, event }) => event.type === "tool.settled" && event.peer === context.peer,
      isToolCall: ({ event }) => event.type === "companion.message" && event.message.type === "tool.call",
      isUnknownTool: ({ event }) => event.type === "companion.message" && event.message.type === "tool.unknown",
      isForgotten: ({ event }) => event.type === "companion.message" && event.message.type === "forgotten",
    },
    actions: {
      tell: sendTo(LINK_ID, ({ context }, message: CompanionMessage): LinkCommand => {
        if (context.peer === undefined) {
          throw new Error(`Expected a companion to send '${message.type}' to, but none said hello`);
        }

        return { type: "link.send", peer: context.peer, message };
      }),
      dropCompanion: assign({ companion: undefined, peer: undefined }),
      greetCompanion: assign(({ event }) =>
        event.type === "companion.greeted" ? { companion: event.companion, peer: event.peer } : {},
      ),
      addActivity: enqueueActions(({ enqueue, context }, entry: ConnectActivity) => {
        enqueue.assign({
          activity: entry.kind === "text" ? withText(context.activity, entry) : withActivity(context.activity, entry),
        });
        enqueue.emit({ type: "activity.added", activity: entry });
      }),
      /** Answers a tool this tab does not know, as a newer companion may call, so the call does not time out. */
      refuseUnknownTool: sendTo(LINK_ID, ({ event }): LinkCommand => {
        if (event.type !== "companion.message" || event.message.type !== "tool.unknown") {
          throw new Error(`Expected a tool.unknown message, but got '${event.type}'`);
        }

        return {
          type: "link.send",
          peer: event.peer,
          message: {
            type: "tool.result",
            id: event.message.id,
            ok: false,
            error: {
              code: "unknown_tool",
              message: `This Drizzle Run tab has no ${event.message.name} tool. Reload the tab to get the latest version.`,
            },
          },
        };
      }),
      /** Checks a tool call and hands it to the host, or answers the refusal at once. */
      takeToolCall: enqueueActions(({ enqueue, context, event }) => {
        if (event.type !== "companion.message" || event.message.type !== "tool.call") {
          return;
        }

        const { peer } = event;
        const { id, name, input, conversation } = event.message;
        const at = now();
        const refuse = (error: ToolError, status: "failed" | "refused", summary?: ConnectToolSummary) => {
          const entry: ConnectActivity = {
            kind: "tool",
            id,
            name,
            ...(conversation ? { conversation } : {}),
            status,
            error,
            ...(summary ? { summary } : {}),
            at,
          };

          enqueue.assign({ activity: withActivity(context.activity, entry) });
          enqueue.emit({ type: "activity.added", activity: entry });
          enqueue.sendTo(LINK_ID, {
            type: "link.send",
            peer,
            message: { type: "tool.result", id, ok: false, error },
          } satisfies LinkCommand);
        };

        const scope = services.toolScope?.() ?? "project";

        if (!isToolInScope(name, scope)) {
          refuse({ code: "unavailable", message: scopeRefusal(name, scope) }, "refused");

          return;
        }

        // A chat's call acts on the chat's project in the chat's mode, never on whatever is open now.
        const open = services.openProject?.();
        const chat = conversation === undefined ? undefined : context.chats[conversation];

        if (conversation !== undefined && chat === undefined) {
          refuse(
            {
              code: "unavailable",
              message: "This chat was not started in this tab. Ask the user to send the message again.",
            },
            "refused",
          );

          return;
        }

        if (chat !== undefined && chat.projectId !== open?.id) {
          refuse(
            {
              code: "unavailable",
              message: "The user left this chat's project, so its tools are closed. Stop here and wait for the user.",
            },
            "refused",
          );

          return;
        }

        const mode = chat?.mode ?? context.mode;

        if (connectTool(name).edits && mode !== "edit") {
          refuse(
            {
              code: "edit_mode_required",
              message:
                "The chat is in Ask mode, so it reads and runs without changing files. " +
                "Ask the user to allow edits in this chat, then try again.",
            },
            "refused",
            refusedEditSummary(name, input),
          );
          enqueue.emit({ type: "edit.requested", tool: name, ...(conversation ? { conversation } : {}) });

          return;
        }

        const parsed = parseToolInput(name, input);

        if (!parsed.ok) {
          refuse({ code: "invalid_input", message: parsed.message }, "failed");

          return;
        }

        const request: ConnectToolRequest = {
          id,
          call: parsed.call,
          mode,
          ...(conversation ? { conversation } : {}),
          ...(open ? { projectId: open.id } : {}),
        };

        // An agent never runs someone else's code on its own: the user presses Run first.
        if (parsed.call.name === "run" && open?.origin === "community") {
          const run: PendingRun = {
            id,
            request,
            peer,
            projectId: open.id,
            ...(open.name ? { projectName: open.name } : {}),
            ...(conversation ? { conversation } : {}),
            createdAt: at,
          };
          const waiting: ConnectActivity = {
            kind: "tool",
            id,
            name,
            ...(conversation ? { conversation } : {}),
            status: "waiting",
            summary: { label: "Asked to run", meta: "waiting for you" },
            at,
          };

          enqueue.assign({
            activity: withActivity(context.activity, waiting),
            pendingRuns: [...context.pendingRuns, run],
          });
          enqueue.emit({ type: "activity.added", activity: waiting });
          enqueue.emit({ type: "run.requested", run });
          enqueue.raise(
            { type: "run.declined", id, message: "The user did not run it in time." },
            { id: `run-${id}`, delay: RUN_CONFIRM_TIMEOUT_MS },
          );

          return;
        }

        const entry: ConnectActivity = {
          kind: "tool",
          id,
          name,
          ...(conversation ? { conversation } : {}),
          status: "running",
          at,
        };

        enqueue.assign({ activity: withActivity(context.activity, entry) });
        enqueue.emit({ type: "activity.added", activity: entry });
        enqueue.sendTo("jobs", { type: "tool.run", request, peer } satisfies Job);
      }),
      /** Runs an agent's run of a community project the user confirmed, if its project is still open. */
      confirmRun: enqueueActions(({ enqueue, context, event }) => {
        const run = event.type === "run.confirm" ? context.pendingRuns.find((item) => item.id === event.id) : undefined;

        if (run === undefined) {
          return;
        }

        enqueue.cancel(`run-${run.id}`);

        if (services.openProject?.()?.id !== run.projectId) {
          enqueue.raise({ type: "run.declined", id: run.id, message: "The user left this project before it ran." });

          return;
        }

        enqueue.assign({
          pendingRuns: context.pendingRuns.filter((item) => item.id !== run.id),
          activity: withToolChange(context.activity, run.id, {
            status: "running",
            summary: { label: "Ran the project" },
          }),
        });

        enqueue.sendTo("jobs", { type: "tool.run", request: run.request, peer: run.peer } satisfies Job);
      }),
      /** Ends a waiting run unrun, and keeps why on its row. */
      declineRun: enqueueActions(({ enqueue, context, event }) => {
        const run =
          event.type === "run.declined" ? context.pendingRuns.find((item) => item.id === event.id) : undefined;

        if (event.type !== "run.declined" || run === undefined) {
          return;
        }

        const error: ToolError = { code: "unavailable", message: event.message };

        enqueue.cancel(`run-${run.id}`);
        enqueue.assign({
          pendingRuns: context.pendingRuns.filter((item) => item.id !== run.id),
          activity: withToolChange(context.activity, run.id, {
            status: "refused",
            error,
            summary: { label: "Asked to run", meta: "not run" },
          }),
        });
      }),
      /** Tells the companion a waiting run did not happen, and why. */
      answerDeclinedRun: enqueueActions(({ enqueue, context, event }) => {
        const run =
          event.type === "run.declined" ? context.pendingRuns.find((item) => item.id === event.id) : undefined;

        if (event.type !== "run.declined" || run === undefined) {
          return;
        }

        enqueue.sendTo(LINK_ID, {
          type: "link.send",
          peer: run.peer,
          message: {
            type: "tool.result",
            id: run.id,
            ok: false,
            error: { code: "unavailable", message: event.message },
          },
        } satisfies LinkCommand);
      }),
      /** Stops chat turns whose project is no longer open. */
      stopStrayChats: enqueueActions(({ enqueue, context }) => {
        const { peer } = context;

        if (peer === undefined) {
          throw new Error("Expected a companion to stop stray chats on, but none said hello");
        }

        for (const conversation of findStrayChats(context.chats, context.activity, services.openProject?.())) {
          enqueue.sendTo(LINK_ID, {
            type: "link.send",
            peer,
            message: { type: "chat.stop", conversation },
          } satisfies LinkCommand);
        }
      }),
      /** Declines runs of a project that closed. */
      declineStrayRuns: enqueueActions(({ enqueue, context }) => {
        const open = services.openProject?.();

        for (const run of context.pendingRuns) {
          if (run.projectId !== open?.id) {
            enqueue.raise({ type: "run.declined", id: run.id, message: "The user left this project before it ran." });
          }
        }
      }),
      /** The link is gone, so waiting runs can no longer be answered: they end here, not run. */
      abandonRuns: enqueueActions(({ enqueue, context }) => {
        const error: ToolError = { code: "unavailable", message: "The companion left before the user ran it." };

        for (const run of context.pendingRuns) {
          enqueue.cancel(`run-${run.id}`);
        }

        enqueue.assign({
          pendingRuns: [],
          activity: context.pendingRuns.reduce(
            (activity, run) => withToolChange(activity, run.id, { status: "refused", error }),
            context.activity,
          ),
        });
      }),
      // A turn the companion was answering never ends once it is gone: the chat shows it failed, so Send comes back.
      endWorkingTurns: enqueueActions(({ enqueue, context }) => {
        const conversations = new Set(
          context.activity.flatMap((entry) => (entry.kind === "turn" ? [entry.conversation] : [])),
        );
        let activity = context.activity;

        for (const conversation of conversations) {
          const turn = workingTurn(activity, conversation);

          if (turn === undefined) {
            continue;
          }

          const entry: ConnectActivity = {
            kind: "turn",
            conversation,
            turn,
            state: "failed",
            error: "The chat link closed before the answer ended.",
            at: now(),
          };

          activity = withActivity(activity, entry);
          enqueue.emit({ type: "activity.added", activity: entry });
        }

        enqueue.assign({ activity });
      }),
      saveEdits: sendTo("editStore", ({ context }): EditStoreCommand => ({
        type: "edits.save",
        edits: context.pendingEdits,
      })),
      /** Keeps a settled call's outcome on its row, and its edit, which waits for Keep or Undo. */
      recordToolOutcome: enqueueActions(({ enqueue, context, event }) => {
        if (event.type !== "tool.settled") {
          return;
        }

        const { request } = event;
        const result = resolveToolResult(event.outcome);
        const edit: PendingEdit | undefined =
          result.ok && result.pendingEdit
            ? { ...result.pendingEdit, id: getEditId(request), toolCallId: request.id, createdAt: now() }
            : undefined;

        enqueue.assign({
          activity: withToolChange(context.activity, request.id, {
            status: result.ok ? "done" : "failed",
            ...(result.summary ? { summary: result.summary } : {}),
            ...(result.ok ? {} : { error: result.error }),
            ...(edit ? { edit: { id: edit.id, decision: "pending" as const } } : {}),
          }),
          ...(edit ? { pendingEdits: [...context.pendingEdits, edit] } : {}),
        });

        if (edit) {
          enqueue.emit({ type: "edit.pending", edit });
          enqueue.raise({ type: "edits.changed" });
        }
      }),
      answerTool: sendTo(LINK_ID, ({ event }): LinkCommand => {
        if (event.type !== "tool.settled") {
          throw new Error(`Expected a tool.settled event, but got '${event.type}'`);
        }

        return { type: "link.send", peer: event.peer, message: toToolResultMessage(event.request, event.outcome) };
      }),
      /** A result its companion never got: the row says so, keeping the error of a call that failed. */
      markUnanswered: assign(({ context, event }) => {
        const id =
          event.type === "tool.settled"
            ? event.request.id
            : event.type === "link.send.refused" && event.message.type === "tool.result"
              ? event.message.id
              : undefined;

        return {
          activity: context.activity.map((entry) =>
            entry.kind === "tool" && entry.id === id && entry.status === "done"
              ? { ...entry, error: UNANSWERED_TOOL_ERROR }
              : entry,
          ),
        };
      }),
      takeMessage: enqueueActions(({ enqueue, context, event }) => {
        if (event.type !== "companion.message") {
          return;
        }

        const { message } = event;
        const at = now();

        switch (message.type) {
          case "agent.text":
            enqueue.assign({
              activity: withText(context.activity, {
                kind: "text",
                conversation: message.conversation,
                turn: message.turn,
                text: message.text,
                at,
              }),
            });
            enqueue.emit({
              type: "activity.added",
              activity: {
                kind: "text",
                conversation: message.conversation,
                turn: message.turn,
                text: message.text,
                at,
              },
            });

            return;

          case "agent.turn": {
            const entry: ConnectActivity = {
              kind: "turn",
              conversation: message.conversation,
              turn: message.turn,
              state: message.state,
              ...(message.error ? { error: message.error } : {}),
              at,
            };

            enqueue.assign({ activity: withActivity(context.activity, entry) });
            enqueue.emit({ type: "activity.added", activity: entry });

            // A run the turn asked for has no one to answer once the turn ends.
            if (message.state !== "started") {
              for (const run of context.pendingRuns) {
                if (run.conversation === message.conversation) {
                  enqueue.raise({
                    type: "run.declined",
                    id: run.id,
                    message: "The turn ended before the user ran it.",
                  });
                }
              }
            }

            return;
          }

          case "agent.chosen":
            if (context.companion) {
              enqueue.assign({ companion: { ...context.companion, agent: message.agent } });
            }

            return;

          case "forget":
          case "forgotten":
          case "tab.active":
          case "agent.choose":
          case "chat.send":
          case "chat.stop":
          case "tool.call":
          // Answered `unknown_tool` by the transitions that guard on it.
          case "tool.unknown":
          case "tool.result":
            return;
        }
      }),
      keepEdit: enqueueActions(({ enqueue, context, event }) => {
        const edit = event.type === "edit.keep" ? context.pendingEdits.find((item) => item.id === event.id) : undefined;

        // An Undo putting files back now decides the edit; one still queued is dropped, so Keep wins.
        if (edit === undefined || context.runningUndo === edit.id) {
          return;
        }

        if (context.queuedUndos.includes(edit.id)) {
          enqueue.sendTo("jobs", { type: "undo.cancel", id: edit.id } satisfies Job);
        }

        enqueue.assign({
          queuedUndos: context.queuedUndos.filter((id) => id !== edit.id),
          pendingEdits: context.pendingEdits.filter((item) => item.id !== edit.id),
          undoErrors: omit(context.undoErrors, [edit.id]),
          activity: withEditDecision(context.activity, edit.id, "kept"),
        });
        enqueue.emit({ type: "edit.kept", edit });
        enqueue.raise({ type: "edits.changed" });
      }),
      undoEdit: enqueueActions(({ enqueue, context, event }) => {
        const edit = event.type === "edit.undo" ? context.pendingEdits.find((item) => item.id === event.id) : undefined;

        // A second Undo of the same edit while the first waits or runs would put the files back twice.
        if (edit === undefined || context.queuedUndos.includes(edit.id) || context.runningUndo === edit.id) {
          return;
        }

        enqueue.assign({ queuedUndos: [...context.queuedUndos, edit.id] });
        enqueue.sendTo("jobs", { type: "undo.run", edit } satisfies Job);
      }),
      startUndo: assign(({ context, event }) =>
        event.type === "undo.started"
          ? { queuedUndos: context.queuedUndos.filter((id) => id !== event.id), runningUndo: event.id }
          : {},
      ),
      settleUndo: enqueueActions(({ enqueue, context, event }) => {
        if (event.type !== "undo.settled") {
          return;
        }

        const edit = context.pendingEdits.find((item) => item.id === event.id);

        if (context.runningUndo === event.id) {
          enqueue.assign({ runningUndo: undefined });
        }

        if (edit === undefined) {
          return;
        }

        if (event.error !== undefined) {
          enqueue.assign({ undoErrors: { ...context.undoErrors, [edit.id]: event.error } });
          enqueue.emit({ type: "edit.undo.failed", edit, error: event.error });

          return;
        }

        enqueue.assign({
          pendingEdits: context.pendingEdits.filter((item) => item.id !== edit.id),
          undoErrors: omit(context.undoErrors, [edit.id]),
          activity: withEditDecision(context.activity, edit.id, "undone"),
        });
        enqueue.emit({ type: "edit.undone", edit });
        enqueue.raise({ type: "edits.changed" });
      }),
    },
  }).createMachine({
    id: "connect",
    initial: "loading",
    context: createInitialContext(),
    invoke: [
      { id: "jobs", src: "jobs" },
      { id: "editStore", src: "editStore" },
      {
        src: "restoreEdits",
        // Edits a past page left pending come first; this page may already hold newer ones.
        onDone: {
          actions: assign({
            pendingEdits: ({ context, event }) => [
              ...event.output.filter((edit) => !context.pendingEdits.some((item) => item.id === edit.id)),
              ...context.pendingEdits,
            ],
          }),
        },
      },
    ],
    on: {
      "chat.mode.set": {
        actions: assign({
          mode: ({ event }) => event.mode,
          chats: ({ context, event }) =>
            event.conversation === undefined
              ? context.chats
              : {
                  ...context.chats,
                  [event.conversation]: {
                    projectId: context.chats[event.conversation]?.projectId,
                    mode: event.mode,
                  },
                },
        }),
      },
      "dock.open": { actions: assign({ dock: "open" }) },
      "dock.close": { actions: assign({ dock: "closed" }) },
      "edit.keep": { actions: "keepEdit" },
      "edit.undo": { actions: "undoEdit" },
      "tool.settled": { actions: ["recordToolOutcome", "markUnanswered"] },
      "undo.started": { actions: "startUndo" },
      "undo.settled": { actions: "settleUndo" },
      "view.changed": { actions: "declineStrayRuns" },
      "run.confirm": { actions: "confirmRun" },
      "run.decline": {
        actions: raise(({ event }) => ({
          type: "run.declined" as const,
          id: event.id,
          message: "The user chose not to run it. Explain instead; the user presses Run when ready.",
        })),
      },
      "run.declined": { actions: "declineRun" },
      "edits.changed": { actions: "saveEdits" },
    },
    states: {
      loading: {
        invoke: {
          src: "loadPairing",
          onDone: [
            { guard: "hasPairing", target: "linked", actions: assign({ pairing: ({ event }) => event.output }) },
            { target: "unpaired" },
          ],
          onError: { target: "unpaired", actions: assign({ error: ({ event }) => getErrorText(event.error) }) },
        },
      },
      /** No pairing. The open dock makes a link code once; after a failure or a Forget, only the user does. */
      unpaired: {
        initial: "fresh",
        on: { "pairing.create": "creating" },
        states: {
          fresh: {
            always: { guard: "isDockOpen", target: "#connect.creating" },
          },
          failed: {},
          forgotten: {},
        },
      },
      creating: {
        invoke: {
          src: "createPairing",
          onDone: { target: "linked", actions: assign({ pairing: ({ event }) => event.output, error: "" }) },
          onError: {
            target: "unpaired.failed",
            actions: assign({ error: ({ event }) => getErrorText(event.error) }),
          },
        },
      },
      linked: {
        initial: "connecting",
        invoke: {
          id: LINK_ID,
          src: "link",
          input: ({ context }) => ({ secret: context.pairing?.secret ?? "" }),
        },
        on: {
          "link.closed": [
            {
              guard: "rateLimited",
              target: "limited",
              actions: ["dropCompanion", assign({ refusal: "rate_limited" }), "abandonRuns", "endWorkingTurns"],
            },
            {
              guard: "expired",
              target: "paused",
              actions: ["dropCompanion", assign({ refusal: undefined }), "abandonRuns", "endWorkingTurns"],
            },
            {
              guard: "unproven",
              target: "paused",
              actions: [
                "dropCompanion",
                assign({
                  refusal: undefined,
                  error: "The relay refused this pairing. Reload the page, or pair again.",
                }),
                "abandonRuns",
                "endWorkingTurns",
              ],
            },
            {
              target: "reconnecting",
              actions: ["dropCompanion", assign({ refusal: undefined }), "abandonRuns", "endWorkingTurns"],
            },
          ],
          "companion.message": [
            { guard: "isToolCall", actions: "takeToolCall" },
            { guard: "isUnknownTool", actions: "refuseUnknownTool" },
            { actions: "takeMessage" },
          ],
          "link.send.refused": { actions: "markUnanswered" },
          "tool.settled": [
            { guard: "isCallerLinked", actions: ["recordToolOutcome", "answerTool"] },
            { actions: ["recordToolOutcome", "markUnanswered"] },
          ],
          "run.declined": { actions: ["answerDeclinedRun", "declineRun"] },
          "view.changed": [
            { guard: "hasPeer", actions: ["stopStrayChats", "declineStrayRuns"] },
            { actions: "declineStrayRuns" },
          ],
          "relay.busy": { target: ".busy", actions: assign({ busy: ({ event }) => event.busy }) },
          "relay.quota": { actions: assign({ quota: ({ event }) => event.quota }) },
          "relay.error": { actions: assign({ error: ({ event }) => event.message }) },
          "companion.incompatible": {
            target: ".incompatible",
            actions: ["dropCompanion", assign({ incompatible: ({ event }) => event.range })],
          },
          "companion.left": {
            target: ".waiting",
            actions: ["dropCompanion", "abandonRuns", "endWorkingTurns"],
          },
          "pairing.forget": "clearing",
          "tab.activate": { guard: "hasPeer", actions: { type: "tell", params: { type: "tab.active" } } },
        },
        states: {
          connecting: {
            on: {
              "link.opened": { target: "waiting", actions: assign({ attempt: 0, error: "", refusal: undefined }) },
            },
          },
          waiting: {
            on: {
              "companion.greeted": "#connect.linked.greeted",
            },
          },
          greeted: {
            entry: ["greetCompanion", assign({ companionSeen: true, incompatible: undefined })],
            always: { target: "connected" },
          },
          connected: {
            entry: { type: "tell", params: { type: "tab.active" } },
            // The save runs beside the chat, which reads ready meanwhile: a message sent while it saves still starts
            // its turn.
            initial: "checkingPairing",
            states: {
              checkingPairing: {
                always: [{ guard: "unconfirmed", target: "confirmingPairing" }, { target: "pairingConfirmed" }],
              },
              confirmingPairing: {
                invoke: {
                  src: "confirmPairing",
                  input: ({ context }) => {
                    if (context.pairing === undefined) {
                      throw new Error("No pairing to confirm.");
                    }

                    return context.pairing;
                  },
                  onDone: { target: "pairingConfirmed", actions: assign({ pairing: ({ event }) => event.output }) },
                  onError: { target: "pairingConfirmed" },
                },
              },
              pairingConfirmed: {},
            },
            on: {
              "companion.greeted": { actions: "greetCompanion" },
              "chat.agent.choose": {
                guard: "canChoose",
                actions: [
                  assign({
                    companion: ({ context, event }) =>
                      context.companion ? { ...context.companion, agent: event.agent } : undefined,
                  }),
                  { type: "tell", params: ({ event }) => ({ type: "agent.choose", agent: event.agent }) },
                ],
              },
              "chat.message.send": {
                guard: ({ context, event }) =>
                  context.companion?.mode === "chat" &&
                  context.companion.agent !== undefined &&
                  event.text.trim() !== "" &&
                  event.text.length <= CONNECT_LIMITS.maxChatChars,
                actions: [
                  assign({
                    chats: ({ context, event }) => ({
                      ...context.chats,
                      [event.conversation]: {
                        projectId: event.project?.id,
                        mode:
                          event.scope === undefined || event.scope === "project"
                            ? (context.chats[event.conversation]?.mode ?? context.mode)
                            : "ask",
                      },
                    }),
                  }),
                  {
                    type: "addActivity",
                    params: ({ event }) => ({
                      kind: "user",
                      id: `${event.conversation}-${now()}`,
                      conversation: event.conversation,
                      text: event.text,
                      at: now(),
                    }),
                  },
                  {
                    type: "tell",
                    params: ({ context, event }) => ({
                      type: "chat.send",
                      conversation: event.conversation,
                      text: event.text,
                      mode: context.chats[event.conversation]?.mode ?? "ask",
                      ...(event.project ? { project: event.project } : {}),
                      ...(event.scope ? { scope: event.scope } : {}),
                      ...getTurnAgent(context.companion, event),
                      ...(event.context && event.context.length > 0 ? { context: event.context } : {}),
                    }),
                  },
                ],
              },
              "chat.turn.stop": {
                actions: {
                  type: "tell",
                  params: ({ event }) => ({ type: "chat.stop", conversation: event.conversation }),
                },
              },
              "pairing.forget": "notifyingForget",
              "link.disconnect": { target: "#connect.off", actions: ["dropCompanion", "endWorkingTurns"] },
            },
          },
          busy: {
            after: {
              untilRetry: [{ guard: "hasCompanion", target: "connected" }, { target: "waiting" }],
            },
            exit: assign({ busy: undefined }),
            on: {
              "companion.greeted": { actions: ["greetCompanion", assign({ companionSeen: true })] },
              "companion.left": { actions: ["dropCompanion", "abandonRuns", "endWorkingTurns"] },
              "pairing.forget": { guard: "hasCompanion", target: "notifyingForget" },
            },
          },
          incompatible: {
            on: { "companion.greeted": "#connect.linked.greeted" },
          },
          notifyingForget: {
            entry: { type: "tell", params: { type: "forget" } },
            after: { forgetWait: "#connect.clearing" },
            on: {
              "companion.message": [
                { guard: "isForgotten", target: "#connect.clearing" },
                { guard: "isToolCall", actions: "takeToolCall" },
                { guard: "isUnknownTool", actions: "refuseUnknownTool" },
              ],
              "link.closed": "#connect.clearing",
              "companion.left": "#connect.clearing",
              "relay.busy": {},
              "pairing.forget": {},
            },
          },
        },
      },
      /** The socket dropped: reconnect after the backoff. The tab coming to the front does not cut it short. */
      reconnecting: {
        after: { backoff: { target: "linked", actions: assign({ attempt: ({ context }) => context.attempt + 1 }) } },
        on: {
          "link.retry": { target: "linked", actions: assign({ attempt: 0 }) },
          "pairing.forget": "clearing",
        },
      },
      /**
       * The relay refused the connection: too many from this network. Reconnect after the backoff, which only grows
       * until a connection is welcomed; neither the tab's return nor Retry cuts it short.
       */
      limited: {
        after: { backoff: { target: "linked", actions: assign({ attempt: ({ context }) => context.attempt + 1 }) } },
        on: {
          "pairing.forget": "clearing",
        },
      },
      /**
       * The room expired or is full: reconnect only when asked, such as on the tab's return to the front. The tab's
       * return keeps the backoff, so switching tabs does not reset it.
       */
      paused: {
        on: {
          "link.retry": { target: "linked", actions: assign({ attempt: 0 }) },
          "tab.activate": "linked",
          "pairing.forget": "clearing",
        },
      },
      /** The user disconnected this tab: the pairing stays, and the tab returning to the front does not reconnect. */
      off: {
        on: {
          "link.retry": { target: "linked", actions: assign({ attempt: 0 }) },
          "pairing.forget": "clearing",
        },
      },
      // Forgetting the pairing ends any answer still coming, so no chat waits on a companion it will never hear again.
      clearing: {
        entry: "endWorkingTurns",
        invoke: {
          src: "clearPairing",
          onDone: {
            target: "unpaired.forgotten",
            actions: [
              assign(({ context }) => keepAfterForget(context)),
              emit({ type: "pairing.forgotten" } satisfies ConnectEmitted),
            ],
          },
          onError: {
            target: "unpaired.forgotten",
            actions: assign(({ context, event }) => ({
              ...keepAfterForget(context),
              error: getErrorText(event.error),
            })),
          },
        },
      },
    },
  });
}

function readField(value: unknown, field: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Reflect.get(value, field) : undefined;
}

function resolveShortText(value: unknown) {
  return typeof value === "string" && value.length <= 200 ? value : undefined;
}

/**
 * What a refused edit would have changed, read from its unchecked input only for the chat's
 * "This needs an edit to query.ts" card. Never executed.
 */
export function refusedEditSummary(name: ConnectToolName, input: unknown): ConnectToolSummary | undefined {
  switch (name) {
    case "apply_edits": {
      const edits = readField(input, "edits");
      const paths = Array.isArray(edits)
        ? uniq(
            edits
              .map((edit: unknown) => resolveShortText(readField(edit, "path")))
              .filter((path): path is string => path !== undefined),
          )
        : [];

      return { label: "Edit", ...(paths.length > 0 ? { target: paths.slice(0, 3).join(", ") } : {}) };
    }

    case "switch_release": {
      const version = resolveShortText(readField(input, "orm_version"));

      return { label: "Switch release", ...(version ? { target: version } : {}) };
    }

    case "create_project": {
      const project = resolveShortText(readField(input, "name"));

      return { label: "Create a project", ...(project ? { target: project } : {}) };
    }

    case "fork_project":
    case "get_project":
    case "get_guide":
    case "get_latest_run":
    case "get_problems":
    case "get_query_plans":
    case "get_query_plans_settings":
    case "set_query_plans_settings":
    case "read_file":
    case "read_docs":
    case "run":
      return undefined;
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? { ...value } : { result: value };
}

/** The connect machine built by `createConnectMachine` */
export type ConnectMachine = ReturnType<typeof createConnectMachine>;

/** A snapshot of the connect machine */
export type ConnectSnapshot = SnapshotFrom<ConnectMachine>;

/** What the chat shows, read from the machine's state and context. */
export type ConnectStatus =
  | { kind: "loading" }
  /**
   * No pairing. `fresh`: none was asked for yet. `creating`: making a link code. `failed`: it could not be made; offer
   * Retry. `forgotten`: the user forgot this computer; a new code waits for them to ask.
   */
  | { kind: "unpaired"; reason: "fresh" | "creating" | "forgotten" }
  | { kind: "unpaired"; reason: "failed"; error: string }
  /** A new secret no companion used yet: show `npx @drizzle-run/connect <secret>`. */
  | { kind: "pairing"; secret: string; connecting: boolean }
  /** Paired before: "Start the companion" with `npx @drizzle-run/connect`. */
  | { kind: "waiting"; connecting: boolean }
  /** The companion is connected and lists its agents; the user picks one. */
  | { kind: "choosing"; companion: CompanionInfo }
  | { kind: "ready"; companion: CompanionInfo; agent: AgentId }
  /** `npx @drizzle-run/connect --mcp`: a terminal agent uses the tools; the tab shows its activity. */
  | { kind: "terminal"; companion: CompanionInfo }
  /** The companion was connected and stopped; the chat stays. */
  | { kind: "disconnected"; reconnecting: boolean }
  /** The relay refused this tab's connection: too many from its network. The tab tries again on its own. */
  | { kind: "limited" }
  /** The user disconnected this tab; the pairing and the chat stay until Reconnect. */
  | { kind: "off" }
  | { kind: "busy"; scope: RelayBusyFrame["scope"]; retryAt: string }
  /** The companion speaks another protocol version; one of the two needs updating. */
  | { kind: "incompatible"; companion: { min: number; max: number } }
  | { kind: "forgetting" };

/** Derive what the chat shows from a connect snapshot */
export function connectStatus(snapshot: ConnectSnapshot): ConnectStatus {
  const { context } = snapshot;
  const pairing = context.pairing;

  if (snapshot.matches("loading")) {
    return { kind: "loading" };
  }

  if (snapshot.matches("creating")) {
    return { kind: "unpaired", reason: "creating" };
  }

  if (snapshot.matches({ unpaired: "failed" })) {
    return { kind: "unpaired", reason: "failed", error: context.error };
  }

  if (snapshot.matches({ unpaired: "forgotten" })) {
    return { kind: "unpaired", reason: "forgotten" };
  }

  if (snapshot.matches("unpaired") || pairing === undefined) {
    return { kind: "unpaired", reason: "fresh" };
  }

  if (snapshot.matches("clearing") || snapshot.matches({ linked: "notifyingForget" })) {
    return { kind: "forgetting" };
  }

  if (snapshot.matches("off")) {
    return { kind: "off" };
  }

  if (snapshot.matches({ linked: "busy" }) && context.busy) {
    return { kind: "busy", scope: context.busy.scope, retryAt: context.busy.retryAt };
  }

  if (snapshot.matches({ linked: "incompatible" }) && context.incompatible) {
    return { kind: "incompatible", companion: context.incompatible };
  }

  const companion = context.companion;

  if (companion !== undefined && snapshot.matches({ linked: "connected" })) {
    if (companion.mode === "mcp") {
      return { kind: "terminal", companion };
    }

    return companion.agent === undefined
      ? { kind: "choosing", companion }
      : { kind: "ready", companion, agent: companion.agent };
  }

  // Until a connection is welcomed, the attempt after a refusal still reads limited.
  if (
    snapshot.matches("limited") ||
    (snapshot.matches({ linked: "connecting" }) && context.refusal === "rate_limited")
  ) {
    return { kind: "limited" };
  }

  const connecting = snapshot.matches({ linked: "connecting" }) || snapshot.matches("reconnecting");

  if (context.companionSeen) {
    return { kind: "disconnected", reconnecting: connecting };
  }

  return pairing.confirmedAt === undefined
    ? { kind: "pairing", secret: pairing.secret, connecting }
    : { kind: "waiting", connecting };
}

/** This tab's share of today's AI chat, as the chat shows it. */
export interface ConnectQuota {
  /** `account`: the signed-in user's share. `connection`: a signed-out client's. Unknown before the relay says. */
  per: RelayQuotaFrame["per"] | undefined;
  used: number;
  limit: number;
  /** ISO time, the next UTC midnight. */
  resetAt: string;
}

/**
 * Derive today's share of AI chat from a connect snapshot
 *
 * Full while the relay answers busy for the day, even before it told the share. Undefined before the relay told it.
 */
export function connectQuota(snapshot: ConnectSnapshot): ConnectQuota | undefined {
  const { busy, quota } = snapshot.context;

  if (snapshot.matches({ linked: "busy" }) && busy?.scope === "daily") {
    const limit = quota?.limit ?? 0;

    return { per: quota?.per, used: limit, limit, resetAt: busy.retryAt };
  }

  return quota === undefined
    ? undefined
    : { per: quota.per, used: quota.used, limit: quota.limit, resetAt: quota.resetAt };
}

/** A conversation's turn in progress: the agent is working until it is done, failed, or stopped. */
export function workingTurn(activity: readonly ConnectActivity[], conversation: string): string | undefined {
  let turn: string | undefined;

  for (const entry of activity) {
    if (entry.kind !== "turn" || entry.conversation !== conversation) {
      continue;
    }

    turn = entry.state === "started" ? entry.turn : entry.turn === turn ? undefined : turn;
  }

  return turn;
}
