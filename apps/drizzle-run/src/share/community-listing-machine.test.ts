import { afterEach, describe, expect, it, vi } from "vitest";
import { createActor, waitFor } from "xstate";

import type { CommunityShare } from "../community/contract";
import { VolatileProjectStorage, type ShareLinkRecord } from "../store/storage";
import { communityListingMachine, type CommunityListingServices } from "./community-listing-machine";

const linkId = "123e4567-e89b-42d3-a456-426614174000";
const shared: ShareLinkRecord = {
  linkId,
  publishedAt: "2026-10-10T00:00:00.000Z",
  description: "Link preview words",
};
const listed: ShareLinkRecord = {
  ...shared,
  listing: { topic: "bug-repros", description: "Card words" },
};

function makeListedShare(): CommunityShare {
  return {
    id: linkId,
    title: "Captured",
    description: null,
    topic: "playground",
    releasePair: { dialect: "sqlite", orm: "0.45.4", kit: "0.31.11", guestFlavor: "slim" },
    files: ["query.ts"],
    listedAt: "2026-10-11T00:00:00.000Z",
    owner: { login: "octocat", avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4" },
  };
}

function makeServices({ links = new VolatileProjectStorage() }: { links?: VolatileProjectStorage } = {}) {
  return {
    community: {
      listShareInCommunity: vi.fn(async () => makeListedShare()),
      unlistShareFromCommunity: vi.fn(async () => undefined),
    },
    links,
  } satisfies CommunityListingServices;
}

function start(record: ShareLinkRecord, services: CommunityListingServices) {
  const actor = createActor(communityListingMachine, { input: { services, projectId: "project-1", record } }).start();
  const saved: ShareLinkRecord[] = [];
  actor.on("record.saved", (event) => saved.push(event.record));

  return { actor, saved };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("community listing actor", () => {
  it("should start a new card from the link's description as a playground", () => {
    const { actor } = start(shared, makeServices());

    expect(actor.getSnapshot().context).toMatchObject({ topic: "playground", description: "Link preview words" });
  });

  it("should list the link with the card's topic and trimmed description, and keep it here", async () => {
    const links = new VolatileProjectStorage();
    const services = makeServices({ links });
    const { actor, saved } = start(shared, services);

    actor.send({ type: "topic.change", topic: "bug-repros" });
    actor.send({ type: "description.change", description: "  Card words  " });
    actor.send({ type: "listing.save" });
    await waitFor(actor, (state) => state.matches("idle"));

    expect(services.community.listShareInCommunity).toHaveBeenCalledWith({
      linkId,
      choice: { topic: "bug-repros", description: "Card words" },
      signal: expect.any(AbortSignal),
    });
    const expected = { ...shared, listing: { topic: "bug-repros", description: "Card words" } };
    expect(await links.shareLink("project-1")).toEqual(expected);
    expect(saved).toEqual([expected]);
  });

  it("should unlist a listed link and forget its listing here", async () => {
    const links = new VolatileProjectStorage();
    const services = makeServices({ links });
    const { actor, saved } = start(listed, services);

    actor.send({ type: "listing.remove" });
    await waitFor(actor, (state) => state.matches("idle"));

    expect(services.community.unlistShareFromCommunity).toHaveBeenCalledWith({
      linkId,
      signal: expect.any(AbortSignal),
    });
    expect(await links.shareLink("project-1")).toEqual(shared);
    expect(saved).toEqual([shared]);
  });

  it("should refuse to unlist a link that is not listed", () => {
    const services = makeServices();
    const { actor } = start(shared, services);

    actor.send({ type: "listing.remove" });

    expect(actor.getSnapshot().value).toBe("idle");
    expect(services.community.unlistShareFromCommunity).not.toHaveBeenCalled();
  });

  it("should keep the card and the listing when Community refuses, then save on a new try", async () => {
    const services = makeServices();
    services.community.listShareInCommunity.mockRejectedValueOnce(new Error("Community is unavailable."));
    const { actor, saved } = start(listed, services);

    actor.send({ type: "description.change", description: "New card" });
    actor.send({ type: "listing.save" });
    await waitFor(actor, (state) => state.matches("idle"));

    expect(actor.getSnapshot().context).toMatchObject({
      error: "Community is unavailable.",
      description: "New card",
      record: listed,
    });
    expect(saved).toEqual([]);

    actor.send({ type: "listing.save" });
    await waitFor(actor, (state) => state.matches("idle"));

    expect(actor.getSnapshot().context).toMatchObject({ error: "", record: { listing: { description: "New card" } } });
  });

  it("should ignore card edits while a change is in flight", () => {
    const services = makeServices();
    services.community.listShareInCommunity.mockReturnValue(new Promise(() => undefined));
    const { actor } = start(listed, services);

    actor.send({ type: "listing.save" });
    actor.send({ type: "topic.change", topic: "playground" });
    actor.send({ type: "listing.remove" });

    expect(actor.getSnapshot().value).toBe("saving");
    expect(actor.getSnapshot().context.topic).toBe("bug-repros");
    expect(services.community.unlistShareFromCommunity).not.toHaveBeenCalled();
    actor.stop();
  });
});
