import type { RuntimeCapabilities } from "@drizzle-run/core/contracts";
import { assign, fromCallback, fromPromise, not, setup } from "xstate";

import type { EmbedCapabilityStatus, EmbedFrameErrorCode, EmbedRunSummary } from "../embed-loader/protocol";
import { declareType } from "../lib/declare-type";
import { openRetiredSnapshot, type ChosenRelease, type ProjectRecord } from "../project/projects";
import type { EmbedConnection, EmbedEvent } from "./bridge";
import { toEmbedLoadFailure, type EmbedFailure } from "./embed-failure";
import { resolveEmbedLoad, type EmbedLoadState, type RetiredEmbedPlayground } from "./embed-load";
import type { EmbedSource, RecordedPlayground } from "./embed-source";
import type { RecordedReason } from "./recorded-embed";

/** The page runtime the embed checks and runs on. */
export interface EmbedRuntime {
  checkCapabilities(): Promise<RuntimeCapabilities>;
  dispose(): Promise<void>;
}

/** What the embed load machine hears. */
export type EmbedLoadEvent<Runtime extends EmbedRuntime> =
  | { type: "runtime.ready"; runtime: Runtime }
  | { type: "runtime.failed"; error: unknown }
  | { type: "release.choose"; choices: readonly ChosenRelease[] }
  | { type: "project.update"; project: ProjectRecord }
  | { type: "embed.fail"; message: string }
  | { type: "parent.connect"; connection: EmbedConnection }
  | { type: "parent.connect.opaque"; nonce: string }
  | { type: "run.settled"; run: EmbedRunSummary }
  | { type: "view.shown" };

/** What the parent last heard, replayed to a parent that connects later. */
interface EmbedReport {
  capability: EmbedCapabilityStatus | undefined;
  error: EmbedFrameErrorCode | undefined;
  /** The playground shows, so the loader can swap the frame in. */
  shown: boolean;
}

interface EmbedLoadContext<Runtime extends EmbedRuntime> {
  runtime: Runtime | undefined;
  capabilities: RuntimeCapabilities | undefined;
  recorded: RecordedPlayground | undefined;
  project: ProjectRecord | undefined;
  retired: RetiredEmbedPlayground | undefined;
  failure: EmbedFailure | undefined;
  connection: EmbedConnection | undefined;
  report: EmbedReport;
  toldOpaqueHost: boolean;
}

/** Where the embed loads from, how it gets a runtime, and how it talks to the parent page. */
export interface EmbedLoadDependencies<Runtime extends EmbedRuntime> {
  source: EmbedSource;
  createRuntime: () => Promise<Runtime>;
  post: (connection: EmbedConnection, event: EmbedEvent) => void;
  postUnsupportedHost: (nonce: string) => void;
}

function isRecordableStatus(status: RuntimeCapabilities["status"]): status is RecordedReason {
  return status === "embedding_context_unsupported" || status === "browser_unsupported";
}

function getRecordedReason(capabilities: RuntimeCapabilities | undefined): RecordedReason {
  if (capabilities === undefined || !isRecordableStatus(capabilities.status)) {
    throw new Error(`Expected a browser that cannot run the embed here, but got '${capabilities?.status}'.`);
  }

  return capabilities.status;
}

/**
 * Create the embed load machine
 *
 * ```text
 * preparing ─► checking ─(available)─► loading ─► open | choosingRelease ─release.choose─► open
 *                       ─(cannot run here)─► findingRecorded ─► recorded | unavailable
 *                       ─(other)─► unavailable
 * any ─embed.fail─► failed
 * ```
 *
 * It owns the page runtime, disposed when the machine stops, and what the parent page hears: the capability, an
 * error, and `ready` once a runnable playground has painted (`view.shown`), so the loader never reveals a blank frame. A parent that connects later hears the latest of these again;
 * a settled run goes only to a parent connected when it settles. A parent that connects with another nonce or origin
 * than the first one is ignored, and an opaque parent is told once that it cannot connect.
 */
export function createEmbedLoadMachine<Runtime extends EmbedRuntime>({
  source,
  createRuntime,
  post,
  postUnsupportedHost,
}: EmbedLoadDependencies<Runtime>) {
  const postReport = (connection: EmbedConnection | undefined, report: EmbedReport) => {
    if (connection === undefined) {
      return;
    }

    if (report.error !== undefined) {
      post(connection, { kind: "error", code: report.error });
      return;
    }

    if (report.capability === undefined) {
      return;
    }

    post(connection, { kind: "capability", status: report.capability });

    if (report.shown && report.capability === "available") {
      post(connection, { kind: "ready" });
    }
  };

  return setup({
    types: {
      context: declareType<EmbedLoadContext<Runtime>>(),
      events: declareType<EmbedLoadEvent<Runtime>>(),
    },
    actors: {
      runtime: fromCallback<EmbedLoadEvent<Runtime>>(({ sendBack }) => {
        let active = true;
        const created = createRuntime();

        created.then(
          (runtime) => {
            if (active) {
              sendBack({ type: "runtime.ready", runtime });
            }
          },
          (error: unknown) => {
            if (active) {
              sendBack({ type: "runtime.failed", error });
            }
          },
        );

        return () => {
          active = false;
          created.then((runtime) => runtime.dispose()).catch(() => {});
        };
      }),
      checkCapabilities: fromPromise<RuntimeCapabilities, EmbedRuntime>(({ input }) => input.checkCapabilities()),
      findRecorded: fromPromise<RecordedPlayground | null, RecordedReason>(({ input, signal }) =>
        source.findRecorded(input, signal),
      ),
      loadPlayground: fromPromise<EmbedLoadState>(async ({ signal }) =>
        resolveEmbedLoad(await source.loadPlayground(signal)),
      ),
    },
    guards: {
      isAvailable: (_, capabilities: RuntimeCapabilities) => capabilities.status === "available",
      isRecordable: (_, capabilities: RuntimeCapabilities) => isRecordableStatus(capabilities.status),
      hasRecording: (_, recorded: RecordedPlayground | null) => recorded !== null,
      isLoadedProject: (_, loaded: EmbedLoadState) => loaded.kind === "project",
      isLoadedRetired: (_, loaded: EmbedLoadState) => loaded.kind === "retired",
      isKnownParent: ({ context }, connection: EmbedConnection) =>
        context.connection === undefined ||
        (context.connection.nonce === connection.nonce && context.connection.origin === connection.origin),
      hasToldOpaqueHost: ({ context }) => context.toldOpaqueHost,
    },
    actions: {
      reportCapability: assign(({ context }, status: EmbedCapabilityStatus) => {
        const report = { ...context.report, capability: status, error: undefined };
        postReport(context.connection, report);

        return { report };
      }),
      reportError: assign(({ context }, code: EmbedFrameErrorCode) => {
        if (context.connection !== undefined) {
          post(context.connection, { kind: "error", code });
        }

        return { report: { ...context.report, error: code } };
      }),
      reportShown: assign(({ context }) => {
        const { connection, report } = context;

        if (connection !== undefined && report.error === undefined && report.capability === "available") {
          post(connection, { kind: "ready" });
        }

        return { report: { ...report, shown: true } };
      }),
      setFailure: assign((_, failure: EmbedFailure) => ({ failure })),
    },
  }).createMachine({
    id: "embedLoad",
    initial: "preparing",
    context: {
      runtime: undefined,
      capabilities: undefined,
      recorded: undefined,
      project: undefined,
      retired: undefined,
      failure: undefined,
      connection: undefined,
      report: { capability: undefined, error: undefined, shown: false },
      toldOpaqueHost: false,
    },
    invoke: { src: "runtime" },
    on: {
      "parent.connect": {
        guard: { type: "isKnownParent", params: ({ event }) => event.connection },
        actions: [
          assign({ connection: ({ event }) => event.connection }),
          ({ context }) => postReport(context.connection, context.report),
        ],
      },
      "parent.connect.opaque": {
        guard: not("hasToldOpaqueHost"),
        actions: [({ event }) => postUnsupportedHost(event.nonce), assign({ toldOpaqueHost: true })],
      },
      "run.settled": {
        actions: ({ context, event }) => {
          if (context.connection !== undefined) {
            post(context.connection, { kind: "run-settled", run: event.run });
          }
        },
      },
    },
    states: {
      preparing: {
        on: {
          "runtime.ready": { target: "checking", actions: assign({ runtime: ({ event }) => event.runtime }) },
          "runtime.failed": {
            target: "failed",
            actions: { type: "setFailure", params: ({ event }) => toEmbedLoadFailure(event.error) },
          },
        },
      },
      checking: {
        invoke: {
          src: "checkCapabilities",
          input: ({ context }) => getRuntime(context),
          onDone: [
            {
              guard: { type: "isAvailable", params: ({ event }) => event.output },
              target: "loading",
              actions: [
                assign({ capabilities: ({ event }) => event.output }),
                { type: "reportCapability", params: "available" },
              ],
            },
            {
              guard: { type: "isRecordable", params: ({ event }) => event.output },
              target: "findingRecorded",
              actions: assign({ capabilities: ({ event }) => event.output }),
            },
            {
              target: "unavailable",
              actions: [
                assign({ capabilities: ({ event }) => event.output }),
                { type: "reportError", params: "initialization" },
              ],
            },
          ],
          onError: {
            target: "failed",
            actions: { type: "setFailure", params: ({ event }) => toEmbedLoadFailure(event.error) },
          },
        },
      },
      findingRecorded: {
        invoke: {
          src: "findRecorded",
          input: ({ context }) => getRecordedReason(context.capabilities),
          onDone: [
            {
              guard: { type: "hasRecording", params: ({ event }) => event.output },
              target: "recorded",
              actions: [
                assign({ recorded: ({ event }) => event.output ?? undefined }),
                { type: "reportCapability", params: "recorded" },
              ],
            },
            {
              target: "unavailable",
              actions: {
                type: "reportCapability",
                params: ({ context }) => getRecordedReason(context.capabilities),
              },
            },
          ],
          onError: {
            target: "failed",
            actions: { type: "setFailure", params: ({ event }) => toEmbedLoadFailure(event.error) },
          },
        },
      },
      loading: {
        invoke: {
          src: "loadPlayground",
          onDone: [
            {
              guard: { type: "isLoadedProject", params: ({ event }) => event.output },
              target: "open",
              actions: assign({
                project: ({ event }) => (event.output.kind === "project" ? event.output.project : undefined),
              }),
            },
            {
              guard: { type: "isLoadedRetired", params: ({ event }) => event.output },
              target: "choosingRelease",
              actions: assign({
                retired: ({ event }) => (event.output.kind === "retired" ? event.output.retired : undefined),
              }),
            },
            {
              target: "failed",
              actions: assign({
                failure: ({ event }) => (event.output.kind === "failed" ? event.output.failure : undefined),
              }),
            },
          ],
          onError: {
            target: "failed",
            actions: { type: "setFailure", params: ({ event }) => toEmbedLoadFailure(event.error) },
          },
        },
      },
      choosingRelease: {
        on: {
          "view.shown": { actions: "reportShown" },
          "release.choose": {
            target: "open",
            actions: assign({
              project: ({ context, event }) => {
                const retired = getRetired(context);
                return openRetiredSnapshot(retired.playground.snapshot, retired.releases, event.choices);
              },
            }),
          },
        },
      },
      open: {
        on: {
          "view.shown": { actions: "reportShown" },
          "project.update": { actions: assign({ project: ({ event }) => event.project }) },
          "embed.fail": {
            target: "failed",
            actions: { type: "setFailure", params: ({ event }) => ({ code: "internal", message: event.message }) },
          },
        },
      },
      recorded: {
        on: {
          "view.shown": { actions: "reportShown" },
        },
      },
      unavailable: {},
      failed: {
        entry: { type: "reportError", params: ({ context }) => getFailure(context).code },
      },
    },
  });
}

function getRuntime<Runtime extends EmbedRuntime>(context: EmbedLoadContext<Runtime>): Runtime {
  if (context.runtime === undefined) {
    throw new Error("Expected the embed to hold a runtime once it is created, but got none.");
  }

  return context.runtime;
}

function getRetired(context: EmbedLoadContext<EmbedRuntime>): RetiredEmbedPlayground {
  if (context.retired === undefined) {
    throw new Error("Expected a playground on removed pairs while choosing a release, but got none.");
  }

  return context.retired;
}

function getFailure(context: EmbedLoadContext<EmbedRuntime>): EmbedFailure {
  if (context.failure === undefined) {
    throw new Error("Expected a failure once the embed failed, but got none.");
  }

  return context.failure;
}
