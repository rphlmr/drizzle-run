import { and, assign, setup } from "xstate";

import { declareType } from "./declare-type.js";
import type {
  PlaygroundCapabilityDetail,
  PlaygroundErrorDetail,
  PlaygroundReadyDetail,
  PlaygroundRunSettledDetail,
} from "./events.js";
import type { EmbedCapabilityStatus, EmbedFrameErrorCode, EmbedRunSummary } from "./protocol.js";

/** A capability the page lacks, so the playground cannot show here. */
export type EmbedUnsupportedStatus = Extract<
  EmbedCapabilityStatus,
  "embedding_context_unsupported" | "browser_unsupported"
>;

/** A failure a retry cannot help: the playground does not exist, or the host page cannot be answered. */
export type EmbedUnavailableCode = Extract<EmbedFrameErrorCode, "not_found" | "unopenable" | "unsupported_host">;

/** Why a load attempt failed, as the host's `error` event reports it */
export type EmbedFailureCode = PlaygroundErrorDetail["code"];

/** Whether the host page has an origin the frame can answer; a `file://` page or a sandboxed frame has none. */
export type EmbedHostOrigin = "tuple" | "opaque";

/** The loader machine's input */
export interface EmbedMachineInput {
  hostOrigin: EmbedHostOrigin;
}

/** The loader machine's context */
export interface EmbedMachineContext {
  hostOrigin: EmbedHostOrigin;
  /** The current load attempt's nonce, which every frame message must carry. */
  nonce: string;
  failure: EmbedFailureCode | undefined;
  unsupported: EmbedUnsupportedStatus | undefined;
}

/**
 * An event the loader sends its machine
 *
 * A load event carries the attempt's fresh nonce, or `null` when the browser cannot create one. Frame events carry the
 * nonce of the message they come from.
 */
export type EmbedMachineEvent =
  | { type: "embed.load.activate"; nonce: string | null }
  | { type: "embed.load.retry"; nonce: string | null }
  | { type: "embed.frame.hello"; nonce: string }
  | { type: "embed.frame.ready"; nonce: string }
  | { type: "embed.frame.capability"; nonce: string; status: EmbedCapabilityStatus }
  | { type: "embed.frame.error"; nonce: string; code: EmbedFailureCode }
  | { type: "embed.frame.run.settled"; nonce: string; run: EmbedRunSummary }
  | { type: "embed.dispose" };

/** What the loader machine does to the page and tells the host; `mountPlayground` builds them over the DOM. */
export interface EmbedLoaderEffects {
  showDormant(): void;
  /** Shows the frame, hidden until it reports ready. */
  openFrame(nonce: string): void;
  /** Answers the frame's hello with what to open. */
  connectFrame(nonce: string): void;
  revealFrame(): void;
  removeFrame(): void;
  showFailure(code: EmbedFailureCode): void;
  showUnsupported(status: EmbedUnsupportedStatus): void;
  notifyReady(detail: PlaygroundReadyDetail): void;
  notifyCapability(detail: PlaygroundCapabilityDetail): void;
  notifyError(detail: PlaygroundErrorDetail): void;
  notifyRunSettled(run: PlaygroundRunSettledDetail): void;
  /** Stops listening to the page and puts the host element's content back. */
  restoreHost(): void;
}

const REQUEST_TIMEOUT_MS = 30_000;

const unavailableCodes = new Set<EmbedFailureCode>(["not_found", "unopenable", "unsupported_host"]);

/** True for a failure a retry cannot help */
export function isUnavailableCode(code: EmbedFailureCode): code is EmbedUnavailableCode {
  return unavailableCodes.has(code);
}

function isUnsupportedStatus(status: EmbedCapabilityStatus): status is EmbedUnsupportedStatus {
  return status === "embedding_context_unsupported" || status === "browser_unsupported";
}

function requireNonce(event: EmbedMachineEvent): string {
  if (!("nonce" in event) || event.nonce === null) {
    throw new Error(`Expected a load event with a nonce, but got '${event.type}' without one.`);
  }

  return event.nonce;
}

function requireFailure(context: EmbedMachineContext): EmbedFailureCode {
  if (context.failure === undefined) {
    throw new Error("Expected the loader to record why its load attempt failed, but it recorded nothing.");
  }

  return context.failure;
}

function requireUnsupported(context: EmbedMachineContext): EmbedUnsupportedStatus {
  if (context.unsupported === undefined) {
    throw new Error("Expected the loader to record which capability the page lacks, but it recorded nothing.");
  }

  return context.unsupported;
}

/**
 * Build the embed loader machine over its effects
 *
 * `frame` holds the iframe from a load until a failure or disposal, through `loading` and `ready`; leaving it removes
 * the frame. Every frame event must carry the current attempt's nonce.
 */
export function createEmbedMachine(effects: EmbedLoaderEffects) {
  const embedSetup = setup({
    types: {
      input: declareType<EmbedMachineInput>(),
      context: declareType<EmbedMachineContext>(),
      events: declareType<EmbedMachineEvent>(),
    },
    delays: {
      requestTimeout: REQUEST_TIMEOUT_MS,
    },
    guards: {
      isOpaqueHost: ({ context }) => context.hostOrigin === "opaque",
      lacksNonce: ({ event }) => "nonce" in event && event.nonce === null,
      nonceMatches: ({ context, event }) => "nonce" in event && event.nonce === context.nonce,
      isUnavailableCode: ({ event }) => event.type === "embed.frame.error" && isUnavailableCode(event.code),
      isUnsupportedCapability: ({ event }) =>
        event.type === "embed.frame.capability" && isUnsupportedStatus(event.status),
      isRecordedCapability: ({ event }) => event.type === "embed.frame.capability" && event.status === "recorded",
    },
    actions: {
      showDormant: () => effects.showDormant(),
      openFrame: (_, { nonce }: { nonce: string }) => effects.openFrame(nonce),
      connectFrame: (_, { nonce }: { nonce: string }) => effects.connectFrame(nonce),
      revealFrame: () => effects.revealFrame(),
      removeFrame: () => effects.removeFrame(),
      showFailure: (_, { code }: { code: EmbedFailureCode }) => effects.showFailure(code),
      showUnsupported: (_, { status }: { status: EmbedUnsupportedStatus }) => effects.showUnsupported(status),
      notifyReady: (_, detail: PlaygroundReadyDetail) => effects.notifyReady(detail),
      notifyCapability: (_, detail: PlaygroundCapabilityDetail) => effects.notifyCapability(detail),
      notifyError: (_, detail: PlaygroundErrorDetail) => effects.notifyError(detail),
      notifyRunSettled: (_, { run }: { run: PlaygroundRunSettledDetail }) => effects.notifyRunSettled(run),
      restoreHost: () => effects.restoreHost(),
      recordAttempt: assign({ nonce: ({ event }) => requireNonce(event) }),
      recordOpaqueHost: assign({ failure: "unsupported_host" }),
      recordBrowserUnsupported: assign({ unsupported: "browser_unsupported" }),
    },
  });

  const loadTransitions = [
    {
      guard: "isOpaqueHost",
      target: "unavailable",
      actions: "recordOpaqueHost",
    },
    {
      guard: "lacksNonce",
      target: "unsupported",
      actions: ["recordBrowserUnsupported", { type: "notifyCapability", params: { status: "browser_unsupported" } }],
    },
    {
      target: "frame",
      actions: "recordAttempt",
    },
  ] as const;

  return embedSetup.createMachine({
    id: "embed",
    initial: "dormant",
    context: ({ input }) => ({
      hostOrigin: input.hostOrigin,
      nonce: "",
      failure: undefined,
      unsupported: undefined,
    }),
    on: {
      "embed.dispose": ".disposed",
    },
    states: {
      dormant: {
        entry: "showDormant",
        on: { "embed.load.activate": [...loadTransitions] },
      },
      frame: {
        entry: { type: "openFrame", params: ({ context }) => ({ nonce: context.nonce }) },
        exit: "removeFrame",
        initial: "loading",
        on: {
          "embed.frame.hello": {
            guard: "nonceMatches",
            actions: { type: "connectFrame", params: ({ context }) => ({ nonce: context.nonce }) },
          },
          "embed.frame.capability": [
            {
              guard: and(["nonceMatches", "isUnsupportedCapability"]),
              target: "unsupported",
              actions: [
                assign({
                  unsupported: ({ event }) => (isUnsupportedStatus(event.status) ? event.status : undefined),
                }),
                { type: "notifyCapability", params: ({ event }) => ({ status: event.status }) },
              ],
            },
            {
              guard: "nonceMatches",
              actions: { type: "notifyCapability", params: ({ event }) => ({ status: event.status }) },
            },
          ],
          "embed.frame.error": [
            {
              guard: and(["nonceMatches", "isUnavailableCode"]),
              target: "unavailable",
              actions: assign({ failure: ({ event }) => event.code }),
            },
            {
              guard: "nonceMatches",
              target: "failed",
              actions: assign({ failure: ({ event }) => event.code }),
            },
          ],
        },
        states: {
          loading: {
            after: {
              requestTimeout: {
                target: "#embed.failed",
                actions: assign({ failure: "timeout" }),
              },
            },
            on: {
              "embed.frame.ready": {
                guard: "nonceMatches",
                target: "ready",
              },
              "embed.frame.capability": {
                guard: and(["nonceMatches", "isRecordedCapability"]),
                target: "ready",
                actions: { type: "notifyCapability", params: ({ event }) => ({ status: event.status }) },
              },
            },
          },
          ready: {
            entry: [
              "revealFrame",
              {
                type: "notifyReady",
                params: ({ event }) => ({ mode: event.type === "embed.frame.ready" ? "live" : "recorded" }),
              },
            ],
            on: {
              "embed.frame.run.settled": {
                guard: "nonceMatches",
                actions: { type: "notifyRunSettled", params: ({ event }) => ({ run: event.run }) },
              },
            },
          },
        },
      },
      /** A retry can help: the frame failed to load, reported an error, or never got ready. */
      failed: {
        entry: [
          { type: "notifyError", params: ({ context }) => ({ code: requireFailure(context) }) },
          { type: "showFailure", params: ({ context }) => ({ code: requireFailure(context) }) },
        ],
        on: { "embed.load.retry": [...loadTransitions] },
      },
      unavailable: {
        entry: [
          { type: "notifyError", params: ({ context }) => ({ code: requireFailure(context) }) },
          { type: "showFailure", params: ({ context }) => ({ code: requireFailure(context) }) },
        ],
      },
      unsupported: {
        entry: { type: "showUnsupported", params: ({ context }) => ({ status: requireUnsupported(context) }) },
      },
      disposed: {
        type: "final",
        entry: "restoreHost",
      },
    },
  });
}
