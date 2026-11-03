import type { RuntimeCapabilities } from "@drizzle-run/core/contracts";
import { assign, fromCallback, fromPromise, setup } from "xstate";

import { declareType } from "./declare-type.ts";
import { getErrorText } from "./error-text.ts";

/** What the host prepared for a project, such as its editor models; disposed when the project changes */
export interface EditorSession {
  dispose(): void;
}

/** Progress reported while a project prepares */
export type PreparationEvent =
  | { type: "runtime.done" }
  | { type: "editor.done" }
  | { type: "download.progress"; downloadedBytes: number; totalBytes: number | null };

/** What a check found: the browser's capabilities, and what the host checked with, for its `prepare`. */
export interface ReadinessCheck<TChecked> {
  capabilities: RuntimeCapabilities;
  checked: TChecked;
}

/**
 * How the host checks and prepares one project
 *
 * The machine keeps what `check` resolved and hands it to `prepare`, so nothing passes between them by closure. It
 * calls `release` with it when no prepare will take it: on a retry, a new selection, or a clear. A prepared session
 * owns it from then on.
 */
export interface ReadinessRequest<TSession extends EditorSession = EditorSession, TChecked = undefined> {
  key: string;
  check(signal: AbortSignal): Promise<ReadinessCheck<TChecked>>;
  prepare(checked: TChecked, signal: AbortSignal, report: (event: PreparationEvent) => void): Promise<TSession>;
  release?(checked: TChecked): void;
}

/** Accumulated preparation progress */
export interface PreparationProgress {
  runtimeDone: boolean;
  editorDone: boolean;
  downloadedBytes: number;
  totalBytes: number | null;
}

interface ReadinessContext<TSession extends EditorSession, TChecked> {
  /** The selected project's key; it outlives `request`, which is dropped once the session is prepared. */
  key: string | undefined;
  /**
   * Held only while it may still run: until the session is prepared, or for a retry. Its closures may keep the
   * host's render scope alive, and a render scope holds older snapshots, so a kept request would chain every past
   * session in memory.
   */
  request: ReadinessRequest<TSession, TChecked> | undefined;
  /** What the current attempt's check resolved, held until a prepared session owns it. */
  checked: { value: TChecked } | undefined;
  /** Bumped on every selection and retry so reports from an older attempt are dropped. */
  attempt: number;
  session: TSession | undefined;
  error: string;
  prolonged: boolean;
  capabilities: RuntimeCapabilities | undefined;
  progress: PreparationProgress;
}

type PreparerEvent<TSession extends EditorSession> =
  | { type: "preparation.progress"; attempt: number; event: PreparationEvent }
  | { type: "preparation.done"; attempt: number; session: TSession }
  | { type: "preparation.failed"; attempt: number; error: string };

/** Public events: select a project, retry after a failure, or clear the selection */
export type ReadinessEvent<TSession extends EditorSession = EditorSession, TChecked = undefined> =
  | { type: "readiness.select"; request: ReadinessRequest<TSession, TChecked> }
  | { type: "readiness.retry" }
  | { type: "readiness.clear" }
  | PreparerEvent<TSession>;

const initialProgress: PreparationProgress = {
  runtimeDone: false,
  editorDone: false,
  downloadedBytes: 0,
  totalBytes: null,
};

/** Past this delay, the loader tells the user preparation is taking longer than usual. */
const PROLONGED_PREPARATION_MS = 3_000;

/**
 * The loader's percent: 100 once the runtime is prepared, else the share of its
 * packages downloaded, or null while the download size is unknown.
 */
export function preparationPercent(progress: PreparationProgress): number | null {
  if (progress.runtimeDone) {
    return 100;
  }

  if (progress.totalBytes === null || progress.totalBytes <= 0) {
    return null;
  }

  return Math.min(100, Math.floor((progress.downloadedBytes / progress.totalBytes) * 100));
}

function getCurrentRequest<TSession extends EditorSession, TChecked>(
  context: ReadinessContext<TSession, TChecked>,
): ReadinessRequest<TSession, TChecked> {
  if (!context.request) {
    throw new Error("No project selected");
  }

  return context.request;
}

function getChecked<TSession extends EditorSession, TChecked>(context: ReadinessContext<TSession, TChecked>): TChecked {
  if (context.checked === undefined) {
    throw new Error("Expected a check's result before preparing, but got none.");
  }

  return context.checked.value;
}

/**
 * Create a readiness machine for the host's own session type
 *
 * Checks the browser's capabilities for the selected project, then prepares it with what the check resolved. A new
 * selection disposes the previous session and drops reports from the older attempt. The `ready` state's
 * `context.session` is the `TSession` the request's `prepare` resolved, and `context.key` the selected request's key.
 */
export function createReadinessMachine<TSession extends EditorSession = EditorSession, TChecked = undefined>() {
  return setup({
    types: {
      context: declareType<ReadinessContext<TSession, TChecked>>(),
      events: declareType<ReadinessEvent<TSession, TChecked>>(),
    },
    actors: {
      check: fromPromise(
        async ({ input, signal }: { input: ReadinessRequest<TSession, TChecked>; signal: AbortSignal }) =>
          input.check(signal),
      ),
      prepare: fromCallback<
        PreparerEvent<TSession>,
        { request: ReadinessRequest<TSession, TChecked>; checked: TChecked; attempt: number }
      >(({ input, sendBack }) => {
        const controller = new AbortController();
        const { attempt } = input;
        // The signal guards the attempt, not the session: once prepared, the session
        // owns its resources and leaving `preparing` must not abort it.
        let isPrepared = false;

        input.request
          .prepare(input.checked, controller.signal, (event) => {
            if (!controller.signal.aborted) {
              sendBack({ type: "preparation.progress", attempt, event });
            }
          })
          .then(
            (session) => {
              if (controller.signal.aborted) {
                session.dispose();

                return;
              }

              isPrepared = true;
              sendBack({ type: "preparation.done", attempt, session });
            },
            (cause: unknown) => {
              if (!controller.signal.aborted) {
                sendBack({ type: "preparation.failed", attempt, error: getErrorText(cause) });
              }
            },
          );

        return () => {
          if (!isPrepared) {
            controller.abort();
          }
        };
      }),
    },
    guards: {
      currentAttempt: ({ context, event }) => "attempt" in event && event.attempt === context.attempt,
      browserUnsupported: (_, output: RuntimeCapabilities) => output.status === "browser_unsupported",
      embeddingUnsupported: (_, output: RuntimeCapabilities) => output.status === "embedding_context_unsupported",
      configurationError: (_, output: RuntimeCapabilities) => output.status === "configuration_error",
    },
    actions: {
      dispose: ({ context }) => context.session?.dispose(),
      releaseCheck: ({ context }) => {
        if (context.checked !== undefined) {
          context.request?.release?.(context.checked.value);
        }
      },
      recordCheck: assign((_, check: ReadinessCheck<TChecked>) => ({
        capabilities: check.capabilities,
        checked: { value: check.checked },
      })),
      restart: assign({
        attempt: ({ context }) => context.attempt + 1,
        checked: undefined,
        session: undefined,
        error: "",
        prolonged: false,
        capabilities: undefined,
        progress: initialProgress,
      }),
    },
  }).createMachine({
    id: "readiness",
    initial: "idle",
    context: {
      key: undefined,
      request: undefined,
      checked: undefined,
      attempt: 0,
      session: undefined,
      error: "",
      prolonged: false,
      capabilities: undefined,
      progress: initialProgress,
    },
    on: {
      "readiness.select": {
        target: ".checking",
        reenter: true,
        actions: [
          "releaseCheck",
          "dispose",
          "restart",
          assign({ key: ({ event }) => event.request.key, request: ({ event }) => event.request }),
        ],
      },
      "readiness.clear": {
        target: ".idle",
        actions: [
          "releaseCheck",
          "dispose",
          assign({ key: undefined, request: undefined, checked: undefined, session: undefined }),
        ],
      },
    },
    states: {
      idle: {},
      checking: {
        invoke: {
          src: "check",
          input: ({ context }) => getCurrentRequest(context),
          onDone: [
            {
              guard: { type: "browserUnsupported", params: ({ event }) => event.output.capabilities },
              target: "unsupported.browser",
              actions: { type: "recordCheck", params: ({ event }) => event.output },
            },
            {
              guard: { type: "embeddingUnsupported", params: ({ event }) => event.output.capabilities },
              target: "unsupported.embedding",
              actions: { type: "recordCheck", params: ({ event }) => event.output },
            },
            {
              guard: { type: "configurationError", params: ({ event }) => event.output.capabilities },
              target: "unsupported.configuration",
              actions: { type: "recordCheck", params: ({ event }) => event.output },
            },
            { target: "preparing", actions: { type: "recordCheck", params: ({ event }) => event.output } },
          ],
          onError: { target: "failed", actions: assign({ error: ({ event }) => getErrorText(event.error) }) },
        },
      },
      unsupported: {
        initial: "browser",
        states: {
          browser: {},
          embedding: {},
          configuration: {
            on: { "readiness.retry": { target: "#readiness.checking", actions: ["releaseCheck", "restart"] } },
          },
        },
      },
      preparing: {
        after: { [PROLONGED_PREPARATION_MS]: { actions: assign({ prolonged: true }) } },
        invoke: {
          src: "prepare",
          input: ({ context }) => ({
            request: getCurrentRequest(context),
            checked: getChecked(context),
            attempt: context.attempt,
          }),
        },
        on: {
          "preparation.progress": {
            guard: "currentAttempt",
            actions: assign({
              progress: ({ context, event }) => {
                switch (event.event.type) {
                  case "runtime.done":
                    return { ...context.progress, runtimeDone: true };

                  case "editor.done":
                    return { ...context.progress, editorDone: true };

                  case "download.progress":
                    return {
                      ...context.progress,
                      downloadedBytes: event.event.downloadedBytes,
                      totalBytes: event.event.totalBytes,
                    };
                }
              },
            }),
          },
          "preparation.done": {
            guard: "currentAttempt",
            target: "ready",
            actions: assign({ session: ({ event }) => event.session, request: undefined, checked: undefined }),
          },
          "preparation.failed": {
            guard: "currentAttempt",
            target: "failed",
            actions: assign({ error: ({ event }) => event.error }),
          },
        },
      },
      ready: {},
      failed: { on: { "readiness.retry": { target: "checking", actions: ["releaseCheck", "restart"] } } },
    },
  });
}

/** Readiness machine for a host that reads only `dispose` from its session */
export const readinessMachine = createReadinessMachine();
