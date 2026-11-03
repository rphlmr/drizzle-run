import { assign, emit, fromPromise, setup } from "xstate";

import type { CommunityService } from "../community/contract";
import { DEFAULT_COMMUNITY_TOPIC, type CommunityTopic } from "../community/topics";
import { declareType } from "../lib/declare-type";
import { getErrorText } from "../lib/error-text";
import type { ShareLinkRecord, ShareLinkStore } from "../store/storage";

/** What the Community tab talks to: the Community API, then this browser's share links. */
export interface CommunityListingServices {
  community: Pick<CommunityService, "listShareInCommunity" | "unlistShareFromCommunity">;
  links: Pick<ShareLinkStore, "saveShareLink">;
}

interface CommunityListingInput {
  services: CommunityListingServices;
  projectId: string;
  /** The project's published link, as this browser keeps it. */
  record: ShareLinkRecord;
}

interface ListingSaveRequest {
  services: CommunityListingServices;
  projectId: string;
  record: ShareLinkRecord;
  topic: CommunityTopic;
  description: string;
}

interface ListingRemoveRequest {
  services: CommunityListingServices;
  projectId: string;
  record: ShareLinkRecord;
}

/** What the Community listing machine hears. */
export type CommunityListingEvent =
  | { type: "topic.change"; topic: CommunityTopic }
  | { type: "description.change"; description: string }
  | { type: "listing.save" }
  | { type: "listing.remove" };

/** What the machine tells its owner: the link as this browser now keeps it, after each listing change. */
export type CommunityListingEmitted = { type: "record.saved"; record: ShareLinkRecord };

/** The card's starting choices: the listing's own, or the link's description for a link not listed yet. */
function toListingDraft(record: ShareLinkRecord) {
  return {
    record,
    topic: record.listing?.topic ?? DEFAULT_COMMUNITY_TOPIC,
    description: record.listing?.description ?? record.description ?? "",
  };
}

async function keepRecord(links: CommunityListingServices["links"], projectId: string, record: ShareLinkRecord) {
  await links.saveShareLink(projectId, record).catch((cause: unknown) => {
    console.error("Keeping the share link's Community listing in this browser failed", cause);
  });

  return record;
}

/**
 * A published link's Community listing, apart from publishing
 *
 * `listing.save` lists the link with the card's topic and description, or saves a new card for a listed one. The
 * listing always shows what the link shows. `listing.remove` unlists it. Each change emits `record.saved`, so a later
 * push keeps it. A failure keeps the card and
 * waits for the owner to try again.
 */
export const communityListingMachine = setup({
  types: {
    context: declareType<
      CommunityListingInput & {
        topic: CommunityTopic;
        description: string;
        /** Why the last change to the listing failed. */
        error: string;
      }
    >(),
    input: declareType<CommunityListingInput>(),
    events: declareType<CommunityListingEvent>(),
    emitted: declareType<CommunityListingEmitted>(),
  },
  actions: {
    setTopic: assign(({ event }) => (event.type === "topic.change" ? { topic: event.topic } : {})),
    setDescription: assign(({ event }) =>
      event.type === "description.change" ? { description: event.description } : {},
    ),
  },
  guards: {
    isListed: ({ context }) => context.record.listing !== undefined,
  },
  actors: {
    saveListing: fromPromise<ShareLinkRecord, ListingSaveRequest>(async ({ input, signal }) => {
      const description = input.description.trim();

      await input.services.community.listShareInCommunity({
        linkId: input.record.linkId,
        choice: { topic: input.topic, description },
        signal,
      });

      return keepRecord(input.services.links, input.projectId, {
        ...input.record,
        listing: {
          topic: input.topic,
          ...(description === "" ? {} : { description }),
        },
      });
    }),
    removeListing: fromPromise<ShareLinkRecord, ListingRemoveRequest>(async ({ input, signal }) => {
      await input.services.community.unlistShareFromCommunity({
        linkId: input.record.linkId,
        signal,
      });

      const { listing: _removed, ...record } = input.record;

      return keepRecord(input.services.links, input.projectId, record);
    }),
  },
}).createMachine({
  id: "communityListing",
  initial: "idle",
  context: ({ input }) => ({ ...input, ...toListingDraft(input.record), error: "" }),
  states: {
    idle: {
      on: {
        "topic.change": { actions: "setTopic" },
        "description.change": { actions: "setDescription" },
        "listing.save": { target: "saving" },
        "listing.remove": { guard: "isListed", target: "removing" },
      },
    },
    saving: {
      entry: assign({ error: "" }),
      invoke: {
        src: "saveListing",
        input: ({ context }) => ({
          services: context.services,
          projectId: context.projectId,
          record: context.record,
          topic: context.topic,
          description: context.description,
        }),
        onDone: {
          target: "idle",
          actions: [
            assign(({ event }) => toListingDraft(event.output)),
            emit(({ event }): CommunityListingEmitted => ({ type: "record.saved", record: event.output })),
          ],
        },
        onError: { target: "idle", actions: assign(({ event }) => ({ error: getErrorText(event.error) })) },
      },
    },
    removing: {
      entry: assign({ error: "" }),
      invoke: {
        src: "removeListing",
        input: ({ context }) => ({ services: context.services, projectId: context.projectId, record: context.record }),
        onDone: {
          target: "idle",
          actions: [
            assign(({ event }) => toListingDraft(event.output)),
            emit(({ event }): CommunityListingEmitted => ({ type: "record.saved", record: event.output })),
          ],
        },
        onError: { target: "idle", actions: assign(({ event }) => ({ error: getErrorText(event.error) })) },
      },
    },
  },
});
