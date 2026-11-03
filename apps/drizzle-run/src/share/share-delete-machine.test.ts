import { describe, expect, it, vi } from "vitest";
import { createActor, waitFor } from "xstate";

import { VolatileProjectStorage, type ShareLinkRecord } from "../store/storage";
import type { DeletePlaygroundOutcome, DeletePlaygroundRequest } from "./playgrounds-contract";
import { shareDeleteMachine } from "./share-delete-machine";

const link: ShareLinkRecord = {
  linkId: "123e4567-e89b-42d3-a456-426614174000",
  publishedAt: "2026-10-10T00:00:00.000Z",
};

async function startDeletion(deletePlayground: (request: DeletePlaygroundRequest) => Promise<DeletePlaygroundOutcome>) {
  const links = new VolatileProjectStorage();
  await links.saveShareLink("project-1", link);
  await links.preference("project-1", "query.ts");
  const playgrounds = {
    deletePlayground: vi.fn<(request: DeletePlaygroundRequest) => Promise<DeletePlaygroundOutcome>>(deletePlayground),
  };
  const actor = createActor(shareDeleteMachine, {
    input: { services: { playgrounds, links }, projectIds: ["project-1"] },
  }).start();

  return { actor, links, playgrounds };
}

describe("share delete machine", () => {
  it("should send nothing when the owner cancels the question", async () => {
    const { actor, links, playgrounds } = await startDeletion(async () => "deleted");

    actor.send({ type: "delete.open", link });
    expect(actor.getSnapshot().matches("confirming")).toBe(true);
    actor.send({ type: "delete.cancel" });

    expect(actor.getSnapshot().matches("idle")).toBe(true);
    expect(playgrounds.deletePlayground).not.toHaveBeenCalled();
    expect(await links.shareLink("project-1")).toEqual(link);
    actor.stop();
  });

  it("should ask about a share given as input, and forget its link on every project that still points at it", async () => {
    const links = new VolatileProjectStorage();
    const other = { ...link, linkId: "223e4567-e89b-42d3-a456-426614174000" };
    await links.saveShareLink("project-1", link);
    await links.saveShareLink("project-2", other);
    await links.saveShareLink("project-3", link);
    const playgrounds = { deletePlayground: vi.fn(async (): Promise<DeletePlaygroundOutcome> => "deleted") };
    const actor = createActor(shareDeleteMachine, {
      input: {
        services: { playgrounds, links },
        projectIds: ["project-1", "project-2", "project-3"],
        link: { linkId: link.linkId, publishedAt: link.publishedAt },
      },
    }).start();

    expect(actor.getSnapshot().matches("confirming")).toBe(true);
    actor.send({ type: "delete.confirm" });
    await waitFor(actor, (snapshot) => snapshot.status === "done");

    expect(playgrounds.deletePlayground).toHaveBeenCalledWith(expect.objectContaining({ linkId: link.linkId }));
    expect(await links.shareLink("project-1")).toBeUndefined();
    expect(await links.shareLink("project-2")).toEqual(other);
    expect(await links.shareLink("project-3")).toBeUndefined();
  });

  it("should delete the share, then forget only its link here", async () => {
    const { actor, links, playgrounds } = await startDeletion(async () => "deleted");

    actor.send({ type: "delete.open", link });
    actor.send({ type: "delete.confirm" });
    await waitFor(actor, (snapshot) => snapshot.matches("deleted"));

    expect(playgrounds.deletePlayground).toHaveBeenCalledWith({
      linkId: link.linkId,
      signal: expect.any(AbortSignal),
    });
    expect(actor.getSnapshot().context.outcome).toBe("deleted");
    expect(await links.shareLink("project-1")).toBeUndefined();
    expect(await links.preference("project-1")).toBe("query.ts");
  });

  it("should forget the link when the share was already gone", async () => {
    const { actor, links } = await startDeletion(async () => "alreadyGone");

    actor.send({ type: "delete.open", link });
    actor.send({ type: "delete.confirm" });
    await waitFor(actor, (snapshot) => snapshot.matches("deleted"));

    expect(actor.getSnapshot().context.outcome).toBe("alreadyGone");
    expect(await links.shareLink("project-1")).toBeUndefined();
  });

  it("should refuse a second confirm and a cancel while the deletion runs", async () => {
    const pending = Promise.withResolvers<DeletePlaygroundOutcome>();
    const { actor, playgrounds } = await startDeletion(() => pending.promise);

    actor.send({ type: "delete.open", link });
    actor.send({ type: "delete.confirm" });
    actor.send({ type: "delete.confirm" });
    actor.send({ type: "delete.cancel" });

    expect(actor.getSnapshot().matches("deleting")).toBe(true);
    expect(playgrounds.deletePlayground).toHaveBeenCalledTimes(1);
    pending.resolve("deleted");
    await waitFor(actor, (snapshot) => snapshot.matches("deleted"));
    expect(playgrounds.deletePlayground).toHaveBeenCalledTimes(1);
  });

  it("should show a failure, keep the link, and delete only on a deliberate retry", async () => {
    let refused = true;
    const { actor, links, playgrounds } = await startDeletion(async () => {
      if (refused) {
        throw new Error("Deleting shares is temporarily unavailable. Retry in a moment.");
      }

      return "deleted";
    });

    actor.send({ type: "delete.open", link });
    actor.send({ type: "delete.confirm" });
    await waitFor(actor, (snapshot) => snapshot.matches("failed"));

    expect(actor.getSnapshot().context.error).toBe("Deleting shares is temporarily unavailable. Retry in a moment.");
    expect(await links.shareLink("project-1")).toEqual(link);
    expect(playgrounds.deletePlayground).toHaveBeenCalledTimes(1);

    refused = false;
    actor.send({ type: "delete.confirm" });
    await waitFor(actor, (snapshot) => snapshot.matches("deleted"));

    expect(playgrounds.deletePlayground).toHaveBeenCalledTimes(2);
    expect(await links.shareLink("project-1")).toBeUndefined();
  });

  it("should retry a failed cleanup without deleting again", async () => {
    const { actor, links, playgrounds } = await startDeletion(async () => "deleted");
    const forget = vi
      .spyOn(links, "deleteShareLink")
      .mockRejectedValueOnce(new Error("The local store is unavailable."));

    actor.send({ type: "delete.open", link });
    actor.send({ type: "delete.confirm" });
    await waitFor(actor, (snapshot) => snapshot.matches("cleanupFailed"));

    expect(actor.getSnapshot().context.error).toBe("The local store is unavailable.");
    actor.send({ type: "delete.confirm" });
    expect(actor.getSnapshot().matches("cleanupFailed")).toBe(true);

    actor.send({ type: "cleanup.retry" });
    await waitFor(actor, (snapshot) => snapshot.matches("deleted"));

    expect(playgrounds.deletePlayground).toHaveBeenCalledTimes(1);
    expect(forget).toHaveBeenCalledTimes(2);
    expect(await links.shareLink("project-1")).toBeUndefined();
  });

  it("should keep a different link saved while the deletion ran", async () => {
    const pending = Promise.withResolvers<DeletePlaygroundOutcome>();
    const { actor, links } = await startDeletion(() => pending.promise);
    const newer: ShareLinkRecord = { ...link, linkId: "223e4567-e89b-42d3-a456-426614174000" };

    actor.send({ type: "delete.open", link });
    actor.send({ type: "delete.confirm" });
    await links.saveShareLink("project-1", newer);
    pending.resolve("deleted");
    await waitFor(actor, (snapshot) => snapshot.matches("deleted"));

    expect(await links.shareLink("project-1")).toEqual(newer);
  });

  it("should abort the request when the dialog goes away", async () => {
    let received: AbortSignal | undefined;
    const { actor } = await startDeletion(({ signal }) => {
      received = signal;

      return new Promise<DeletePlaygroundOutcome>(() => {});
    });

    actor.send({ type: "delete.open", link });
    actor.send({ type: "delete.confirm" });
    await waitFor(actor, () => received !== undefined);
    actor.stop();

    expect(received?.aborted).toBe(true);
  });
});
