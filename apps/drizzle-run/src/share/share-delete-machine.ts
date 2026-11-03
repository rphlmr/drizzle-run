import { assign, fromPromise, setup } from "xstate";

import { declareType } from "../lib/declare-type";
import { getErrorText } from "../lib/error-text";
import type { ShareLinkRecord, ShareLinkStore } from "../store/storage";
import type { DeletePlaygroundOutcome, PlaygroundsService } from "./playgrounds-contract";

/** What deleting a share talks to: the playground API first, then this browser's share links. */
export interface ShareDeleteServices {
  playgrounds: Pick<PlaygroundsService, "deletePlayground">;
  links: Pick<ShareLinkStore, "deleteShareLink">;
}

interface ShareDeleteInput {
  services: ShareDeleteServices;
  /** The local projects whose link to the share this browser forgets once it is gone; the projects stay. */
  projectIds: readonly string[];
  /** The share to ask about at once; without it, the machine waits for `delete.open`. */
  link?: ShareLinkRecord;
}

interface RemoteDeleteRequest {
  playgrounds: ShareDeleteServices["playgrounds"];
  link: ShareLinkRecord;
}

interface LocalCleanupRequest {
  links: ShareDeleteServices["links"];
  projectIds: readonly string[];
  linkId: string;
}

/** What the share deletion machine hears. */
export type ShareDeleteEvent =
  | { type: "delete.open"; link: ShareLinkRecord }
  | { type: "delete.cancel" }
  | { type: "delete.confirm" }
  | { type: "cleanup.retry" };

function requireLink(link: ShareLinkRecord | undefined): ShareLinkRecord {
  if (link === undefined) {
    throw new Error("The share to delete is unavailable.");
  }

  return link;
}

/**
 * Deletes a share once its owner confirms, then forgets its link in this browser
 *
 * Cancelling the question sends nothing. While the request runs, cancel and a second confirm are refused; a failure
 * waits for a deliberate `delete.confirm` to retry. Only after the Worker deleted the share, or answered that it was
 * already gone, does this browser forget the link, and only while it is still that link. A failed cleanup retries
 * the cleanup alone with `cleanup.retry`, never the deletion.
 */
export const shareDeleteMachine = setup({
  types: {
    context: declareType<
      ShareDeleteInput & {
        /** The link being deleted, set when the owner asks. */
        link: ShareLinkRecord | undefined;
        /** Why the deletion or the cleanup failed. */
        error: string;
        /** What the Worker answered, once it did. */
        outcome: DeletePlaygroundOutcome | undefined;
      }
    >(),
    input: declareType<ShareDeleteInput>(),
    events: declareType<ShareDeleteEvent>(),
  },
  actors: {
    deleteRemote: fromPromise<DeletePlaygroundOutcome, RemoteDeleteRequest>(({ input, signal }) =>
      input.playgrounds.deletePlayground({ linkId: input.link.linkId, signal }),
    ),
    forgetLink: fromPromise<void, LocalCleanupRequest>(async ({ input }) => {
      await Promise.all(input.projectIds.map((projectId) => input.links.deleteShareLink(projectId, input.linkId)));
    }),
  },
}).createMachine({
  id: "shareDelete",
  initial: "idle",
  context: ({ input }) => ({ ...input, link: input.link, error: "", outcome: undefined }),
  states: {
    idle: {
      always: { guard: ({ context }) => context.link !== undefined, target: "confirming" },
      on: {
        "delete.open": {
          target: "confirming",
          actions: assign(({ event }) => ({ link: event.link, error: "", outcome: undefined })),
        },
      },
    },
    confirming: {
      on: {
        "delete.cancel": { target: "idle", actions: assign({ link: undefined }) },
        "delete.confirm": "deleting",
      },
    },
    deleting: {
      invoke: {
        src: "deleteRemote",
        input: ({ context }) => ({ playgrounds: context.services.playgrounds, link: requireLink(context.link) }),
        onDone: {
          target: "cleaningUp",
          actions: assign(({ event }) => ({ outcome: event.output, error: "" })),
        },
        onError: {
          target: "failed",
          actions: assign(({ event }) => ({ error: getErrorText(event.error) })),
        },
      },
    },
    failed: {
      on: {
        "delete.confirm": { target: "deleting", actions: assign({ error: "" }) },
        "delete.cancel": { target: "idle", actions: assign({ link: undefined, error: "" }) },
      },
    },
    cleaningUp: {
      invoke: {
        src: "forgetLink",
        input: ({ context }) => ({
          links: context.services.links,
          projectIds: context.projectIds,
          linkId: requireLink(context.link).linkId,
        }),
        onDone: { target: "deleted", actions: assign({ error: "" }) },
        onError: {
          target: "cleanupFailed",
          actions: assign(({ event }) => ({ error: getErrorText(event.error) })),
        },
      },
    },
    // The share is gone: only this browser's link is left, so a retry never repeats the deletion.
    cleanupFailed: {
      on: {
        "cleanup.retry": { target: "cleaningUp", actions: assign({ error: "" }) },
      },
    },
    deleted: { type: "final" },
  },
});
