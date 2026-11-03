import { digestPlaygroundSnapshot, type PlaygroundSnapshot, type RecordedRun } from "@drizzle-run/core/contracts";
import { assign, enqueueActions, fromPromise, setup } from "xstate";

import type { RecordedRunsService } from "../embed/recorded-runs-contract";
import { declareType } from "../lib/declare-type";
import { getErrorText } from "../lib/error-text";
import type { ShareLinkRecord, ShareLinkStore } from "../store/storage";
import type { PlaygroundsService, PublishedPlaygroundLink } from "./playgrounds-contract";

/** The APIs a share publishes with: the snapshot and its recorded run. */
export interface SharePublishServices {
  playgrounds: Pick<PlaygroundsService, "publishPlaygroundSnapshot" | "pushChanges">;
  recordedRuns: Pick<RecordedRunsService, "recordRun">;
}

/** Where the dialog opens for a link shared before: its Link tab, or straight on the push step. */
export type ShareStartView = "link" | "push";

interface SharePublishInput {
  services: SharePublishServices;
  snapshot: PlaygroundSnapshot | undefined;
  idempotencyKey: string | undefined;
  error: string;
  projectId: string;
  /** Where this browser keeps the project's link, read first to learn whether it was shared before. */
  links: ShareLinkStore;
  /** The latest run's recording when it succeeded on exactly the captured snapshot and fits; always published. */
  recording?: RecordedRun;
  startView: ShareStartView;
}

interface PublishRequest {
  playgrounds: SharePublishServices["playgrounds"];
  snapshot: PlaygroundSnapshot;
  idempotencyKey: string;
  description: string;
  projectId: string;
  /** The project's link when this browser shared it before, which then only ever gets pushed changes. */
  existing: ShareLinkRecord | undefined;
  links: ShareLinkStore;
}

/** Records the author's run of what the link now shows. */
interface RecordingRequest {
  recordedRuns: SharePublishServices["recordedRuns"];
  record: ShareLinkRecord;
  recording: RecordedRun;
}

/** What a publish leaves: the link and what this browser keeps for it. */
export interface PublishOutcome {
  link: PublishedPlaygroundLink;
  /** What this browser keeps for the link. */
  record: ShareLinkRecord;
  /** False when the link is public but this browser could not keep it with the project. */
  linkSaved: boolean;
}

/** What the share publication machine hears. */
export type SharePublishEvent =
  | { type: "consent.change"; consent: boolean }
  | { type: "description.change"; description: string }
  /** The link as this browser keeps it now, after a Community change or a check with the server. */
  | { type: "link.change"; record: ShareLinkRecord }
  | { type: "push.open" }
  | { type: "push.cancel" }
  | { type: "share.publish" }
  | { type: "recording.retry" };

/**
 * What the machine tells its owner: the link as this browser now keeps it, after a publish or a push, and
 * `push.done` once a push to an existing link finished with its run's output and the link kept.
 */
export type SharePublishEmitted = { type: "record.saved"; record: ShareLinkRecord } | { type: "push.done" };

/** The form's starting choices: the link's description when it was shared before. */
function toShareChoices(existing: ShareLinkRecord | undefined) {
  return { existing, description: existing?.description ?? "" };
}

/**
 * Reads whether this browser shared the project before, then, after consent, publishes a frozen snapshot as a new link
 * or pushes it to the existing one, then records the author's run on it. A Community listing always shows what the
 * link shows, so a push never lists, unlists, or moves it. The record this browser keeps emits `record.saved`, and a
 * finished push emits `push.done`. A failed recording keeps the published link and waits for `recording.retry`.
 */
export const sharePublishMachine = setup({
  types: {
    context: declareType<
      SharePublishInput & {
        /** The project's link when this browser shared it before; undefined until the lookup is done. */
        existing: ShareLinkRecord | undefined;
        consent: boolean;
        /** Every share's optional one-line description, starting from the link's current one. */
        description: string;
        result: PublishOutcome | undefined;
        /** Why the recording failed after the snapshot was published. */
        recordingError: string;
      }
    >(),
    input: declareType<SharePublishInput>(),
    events: declareType<SharePublishEvent>(),
    emitted: declareType<SharePublishEmitted>(),
  },
  actions: {
    setConsent: assign(({ event }) => (event.type === "consent.change" ? { consent: event.consent } : {})),
    setDescription: assign(({ event }) =>
      event.type === "description.change" ? { description: event.description } : {},
    ),
  },
  guards: {
    hasLink: ({ context }) => context.existing !== undefined,
    opensOnPush: ({ context }) => context.existing !== undefined && context.startView === "push",
    canPublish: ({ context }) =>
      context.consent && context.snapshot !== undefined && context.idempotencyKey !== undefined,
    wantsRecording: ({ context }) => context.recording !== undefined,
  },
  actors: {
    findLink: fromPromise<ShareLinkRecord | undefined, { links: ShareLinkStore; projectId: string }>(({ input }) =>
      input.links.shareLink(input.projectId).catch(() => undefined),
    ),
    publish: fromPromise<PublishOutcome, PublishRequest>(async ({ input, signal }) => {
      const { existing } = input;
      const description = input.description.trim();
      const link = existing
        ? await input.playgrounds.pushChanges({
            linkId: existing.linkId,
            snapshot: input.snapshot,
            description,
            signal,
          })
        : await input.playgrounds.publishPlaygroundSnapshot({
            snapshot: input.snapshot,
            description,
            idempotencyKey: input.idempotencyKey,
            signal,
          });
      const listing = existing?.listing;
      const record: ShareLinkRecord = {
        linkId: link.id,
        publishedAt: link.updatedAt,
        ...(description === "" ? {} : { description }),
        publishedDigest: digestPlaygroundSnapshot(input.snapshot),
        ...(listing === undefined ? {} : { listing }),
      };

      try {
        await input.links.saveShareLink(input.projectId, record);
        return { link, record, linkSaved: true };
      } catch {
        return { link, record, linkSaved: false };
      }
    }),
    recordRun: fromPromise<void, RecordingRequest>(({ input, signal }) =>
      input.recordedRuns.recordRun({
        linkId: input.record.linkId,
        recording: input.recording,
        signal,
      }),
    ),
  },
}).createMachine({
  id: "sharePublish",
  initial: "lookingUp",
  context: ({ input }) => ({
    ...input,
    ...toShareChoices(undefined),
    consent: false,
    result: undefined,
    recordingError: "",
  }),
  states: {
    lookingUp: {
      invoke: {
        src: "findLink",
        input: ({ context }) => ({ links: context.links, projectId: context.projectId }),
        onDone: { target: "start", actions: assign(({ event }) => toShareChoices(event.output)) },
      },
    },
    start: {
      always: [
        { guard: "opensOnPush", target: "preparingPush" },
        { guard: "hasLink", target: "sharing" },
        { target: "ready" },
      ],
    },
    sharing: {
      entry: assign({ consent: false }),
      on: {
        "push.open": "preparingPush",
        "link.change": { actions: assign(({ event }) => toShareChoices(event.record)) },
      },
    },
    ready: {
      on: {
        "consent.change": { actions: "setConsent" },
        "description.change": { actions: "setDescription" },
        "share.publish": { guard: "canPublish", target: "publishing", actions: assign({ error: "" }) },
      },
    },
    preparingPush: {
      on: {
        "push.cancel": "sharing",
        "consent.change": { actions: "setConsent" },
        "description.change": { actions: "setDescription" },
        "share.publish": { guard: "canPublish", target: "publishing", actions: assign({ error: "" }) },
      },
    },
    publishing: {
      invoke: {
        src: "publish",
        input: ({ context }) => {
          if (context.snapshot === undefined || context.idempotencyKey === undefined) {
            throw new Error("The captured playground snapshot is unavailable.");
          }

          return {
            playgrounds: context.services.playgrounds,
            snapshot: context.snapshot,
            idempotencyKey: context.idempotencyKey,
            description: context.description,
            projectId: context.projectId,
            existing: context.existing,
            links: context.links,
          };
        },
        onDone: {
          target: "published",
          actions: [
            assign(({ event }) => ({ result: event.output, error: "" })),
            enqueueActions(({ enqueue, event }) => {
              if (event.output.linkSaved) {
                enqueue.emit({ type: "record.saved", record: event.output.record });
              }
            }),
          ],
        },
        onError: {
          target: "failed",
          actions: assign(({ event }) => ({ error: getErrorText(event.error) })),
        },
      },
    },
    published: {
      initial: "deciding",
      states: {
        deciding: {
          always: [{ guard: "wantsRecording", target: "uploading" }, { target: "done" }],
        },
        uploading: {
          invoke: {
            src: "recordRun",
            input: ({ context }) => {
              if (context.result === undefined || context.recording === undefined) {
                throw new Error("The published link or its recording is unavailable.");
              }

              return {
                recordedRuns: context.services.recordedRuns,
                record: context.result.record,
                recording: context.recording,
              };
            },
            onDone: { target: "done", actions: assign({ recordingError: "" }) },
            onError: {
              target: "failed",
              actions: assign(({ event }) => ({ recordingError: getErrorText(event.error) })),
            },
          },
        },
        failed: {
          on: {
            "recording.retry": { target: "uploading", actions: assign({ recordingError: "" }) },
          },
        },
        done: {
          type: "final",
          entry: enqueueActions(({ context, enqueue }) => {
            if (context.existing !== undefined && context.result?.linkSaved === true) {
              enqueue.emit({ type: "push.done" });
            }
          }),
        },
      },
    },
    // A retry repeats the same request: link, description, and idempotency key stay frozen.
    failed: {
      on: {
        "share.publish": { guard: "canPublish", target: "publishing", actions: assign({ error: "" }) },
      },
    },
  },
});
