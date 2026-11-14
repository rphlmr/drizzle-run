import { createRecordedRun, digestPlaygroundSnapshot, type RecordedRun } from "@drizzle-run/core/contracts";
import { fakeRunResult, legacyGuest } from "@drizzle-run/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActor, waitFor, type SnapshotFrom } from "xstate";

import type { CommunityShare } from "../community/contract";
import { createCommunityService } from "../community/service";
import { createRecordedRunsService } from "../embed/recorded-runs-service";
import type { Fetch } from "../lib/api";
import { createProject } from "../project/projects";
import { VolatileProjectStorage, type ShareLinkRecord } from "../store/storage";
import { createPlaygroundsService } from "./playgrounds-service";
import { sharePublishMachine, type SharePublishServices, type ShareStartView } from "./publish-machine";

const origin = "https://run.example.test";
const key = "8e03978e-40d5-43e8-bc93-6894a57f9324";
const linkId = "123e4567-e89b-42d3-a456-426614174000";
const existing: ShareLinkRecord = {
  linkId,
  publishedAt: "2026-10-10T00:00:00.000Z",
};

/** Published, with its recording settled. */
function isSettled(state: SnapshotFrom<typeof sharePublishMachine>) {
  return state.matches({ published: "done" });
}

function makeSnapshot() {
  const project = createProject("Captured", { dialect: "sqlite" });
  return { snapshotVersion: 1 as const, name: project.name, manifest: project.manifest };
}

function makeResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The JSON a mocked `fetch` call sent; a body that is not a string fails the test. */
function readJsonBody(init: RequestInit | undefined): unknown {
  const body = init?.body;

  if (typeof body !== "string") {
    throw new Error(`Expected a JSON string request body, but got ${typeof body}`);
  }

  return JSON.parse(body);
}

function makePublished(frozen: ReturnType<typeof makeSnapshot>) {
  return {
    id: linkId,
    digest: digestPlaygroundSnapshot(frozen),
    updatedAt: "2026-10-11T00:00:00.000Z",
    url: `/s/${linkId}`,
    embedUrl: `/embed/${linkId}`,
  };
}

/** The author's succeeded run of `frozen`, as the Share dialog offers it. */
function makeRecording(frozen: ReturnType<typeof makeSnapshot>): RecordedRun {
  const created = createRecordedRun({
    result: fakeRunResult("succeeded", { target: { dialect: "sqlite" }, displays: [{ label: "Users", values: [] }] }),
    guests: [legacyGuest()],
    snapshotDigest: digestPlaygroundSnapshot(frozen),
    recordedAt: "2026-10-11T00:00:00.000Z",
  });

  if (created.status !== "recorded") {
    throw new Error(`Expected a recording, but got '${created.status}'`);
  }

  return created.recording;
}

/** Services that answer through `fetch`, as the app builds them. */
function makeServices(fetch: Fetch): SharePublishServices {
  const dependencies = { fetch, origin };

  return {
    playgrounds: createPlaygroundsService(dependencies),
    community: createCommunityService(dependencies),
    recordedRuns: createRecordedRunsService(dependencies),
  };
}

/** Services whose calls are mocks: a publish, a push, a listing and a recording that all succeed. */
function makeMockServices(frozen: ReturnType<typeof makeSnapshot>) {
  return {
    playgrounds: {
      publishPlaygroundSnapshot: vi.fn(async () => makePublished(frozen)),
      pushChanges: vi.fn(async () => makePublished(frozen)),
    },
    // The listed share it answers is never read: the actor keeps its own choice.
    community: { listShareInCommunity: vi.fn(async () => ({}) as CommunityShare) },
    recordedRuns: { recordRun: vi.fn(async () => undefined) },
  } satisfies SharePublishServices;
}

interface StartOptions {
  openPushStep?: boolean;
  /** The Worker the services talk to; by default any request fails the test. */
  fetch?: Fetch;
  link?: ShareLinkRecord;
  links?: VolatileProjectStorage;
  recording?: RecordedRun;
  services?: SharePublishServices;
  startView?: ShareStartView;
}

async function start(
  frozen: ReturnType<typeof makeSnapshot>,
  {
    openPushStep = true,
    fetch = async (url) => {
      throw new Error(`Expected no request, but got ${url}`);
    },
    link,
    links = new VolatileProjectStorage(),
    recording,
    services = makeServices(fetch),
    startView = "link",
  }: StartOptions = {},
) {
  if (link) {
    await links.saveShareLink("project-1", link);
  }

  const actor = createActor(sharePublishMachine, {
    input: {
      services,
      recording,
      snapshot: frozen,
      idempotencyKey: key,
      error: "",
      projectId: "project-1",
      links,
      startView,
    },
  }).start();
  await waitFor(actor, (state) => !state.matches("lookingUp"));

  if (link && openPushStep) {
    actor.send({ type: "push.open" });
  }

  return actor;
}

function collectSavedRecords(actor: Awaited<ReturnType<typeof start>>) {
  const saved: ShareLinkRecord[] = [];
  actor.on("record.saved", (event) => saved.push(event.record));

  return saved;
}

function countFinishedPushes(actor: Awaited<ReturnType<typeof start>>) {
  const finished = { count: 0 };
  actor.on("push.done", () => {
    finished.count += 1;
  });

  return finished;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("share publication actor", () => {
  it("should require opening the push step and clear consent when returning to copy the link", async () => {
    const actor = await start(makeSnapshot(), { link: existing, openPushStep: false });

    try {
      expect(actor.getSnapshot().matches("sharing")).toBe(true);
      actor.send({ type: "consent.change", consent: true });
      actor.send({ type: "share.publish" });
      expect(actor.getSnapshot().matches("sharing")).toBe(true);
      expect(actor.getSnapshot().context.consent).toBe(false);
      actor.send({ type: "push.open" });
      actor.send({ type: "consent.change", consent: true });
      actor.send({ type: "description.change", description: "Keep this draft" });
      actor.send({ type: "push.cancel" });
      expect(actor.getSnapshot().matches("sharing")).toBe(true);
      actor.send({ type: "push.open" });
      expect(actor.getSnapshot().matches("preparingPush")).toBe(true);
      expect(actor.getSnapshot().context).toMatchObject({ consent: false, description: "Keep this draft" });
    } finally {
      actor.stop();
    }
  });

  it("should wait for consent and retry the frozen snapshot with its original keys", async () => {
    const frozen = makeSnapshot();
    const links = new VolatileProjectStorage();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ error: { code: "snapshot_storage_unavailable" } }, 503))
      .mockResolvedValueOnce(makeResponse(makePublished(frozen)));
    const actor = await start(frozen, { fetch: fetchMock, links });
    const saved = collectSavedRecords(actor);
    const finished = countFinishedPushes(actor);

    expect(actor.getSnapshot().value).toBe("ready");
    actor.send({ type: "visibility.change", visibility: "link" });
    actor.send({ type: "share.publish" });
    expect(actor.getSnapshot().value).toBe("ready");
    expect(fetchMock).not.toHaveBeenCalled();

    actor.send({ type: "consent.change", consent: true });
    actor.send({ type: "share.publish" });
    await waitFor(actor, (state) => state.matches("failed"));
    expect(actor.getSnapshot().context.error).toContain("temporarily unavailable");

    actor.send({ type: "share.publish" });
    await waitFor(actor, isSettled);
    expect(actor.getSnapshot().context.result).toMatchObject({ link: { id: linkId }, linkSaved: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(saved).toEqual([await links.shareLink("project-1")]);
    expect(finished.count).toBe(0);

    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(`${origin}/api/playgrounds`);
      expect((init as RequestInit).headers).toMatchObject({ "Idempotency-Key": key });
      expect(readJsonBody(init as RequestInit)).toEqual({ snapshot: frozen, description: null });
    }

    expect(await links.shareLink("project-1")).toEqual({
      linkId,
      publishedAt: "2026-10-11T00:00:00.000Z",
      publishedDigest: digestPlaygroundSnapshot(frozen),
    });
  });

  it("should refuse a publish while it reads the project's link, and read a failed lookup as never shared", async () => {
    const links = new VolatileProjectStorage();
    const lookup = Promise.withResolvers<ShareLinkRecord | undefined>();
    vi.spyOn(links, "shareLink").mockReturnValue(lookup.promise);
    const actor = createActor(sharePublishMachine, {
      input: {
        services: makeServices(async (url) => {
          throw new Error(`Expected no request, but got ${url}`);
        }),
        snapshot: makeSnapshot(),
        idempotencyKey: key,
        error: "",
        projectId: "project-1",
        links,
        startView: "link",
      },
    }).start();

    actor.send({ type: "consent.change", consent: true });
    actor.send({ type: "share.publish" });
    const whileLookingUp = actor.getSnapshot().value;
    lookup.reject(new Error("Store closed"));
    await waitFor(actor, (state) => !state.matches("lookingUp"));

    expect(whileLookingUp).toBe("lookingUp");
    expect(actor.getSnapshot().value).toBe("ready");
    expect(actor.getSnapshot().context).toMatchObject({ existing: undefined, consent: false });
  });

  it("should push changes to the same link when this browser shared the project", async () => {
    const frozen = makeSnapshot();
    const links = new VolatileProjectStorage();
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(makePublished(frozen)));
    const actor = await start(frozen, { fetch: fetchMock, link: existing, links });
    const finished = countFinishedPushes(actor);

    expect(actor.getSnapshot().value).toBe("preparingPush");
    actor.send({ type: "description.change", description: " Add posts " });
    actor.send({ type: "consent.change", consent: true });
    actor.send({ type: "share.publish" });
    await waitFor(actor, isSettled);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${origin}/api/playgrounds/${linkId}`);
    expect((init as RequestInit).method).toBe("PUT");
    expect((init as RequestInit).headers).not.toHaveProperty("Authorization");
    expect((init as RequestInit).headers).not.toHaveProperty("Idempotency-Key");
    expect(readJsonBody(init as RequestInit)).toEqual({ snapshot: frozen, description: "Add posts" });
    expect(await links.shareLink("project-1")).toEqual({
      linkId,
      publishedAt: "2026-10-11T00:00:00.000Z",
      description: "Add posts",
      publishedDigest: digestPlaygroundSnapshot(frozen),
    });
    expect(finished.count).toBe(1);
  });

  it("should retry a failed push on the same link, and never create a link instead", async () => {
    const frozen = makeSnapshot();
    const links = new VolatileProjectStorage();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ error: { code: "snapshot_storage_unavailable" } }, 503))
      .mockResolvedValueOnce(makeResponse(makePublished(frozen)));
    const actor = await start(frozen, { fetch: fetchMock, link: existing, links });

    actor.send({ type: "description.change", description: "First" });
    actor.send({ type: "consent.change", consent: true });
    actor.send({ type: "share.publish" });
    await waitFor(actor, (state) => state.matches("failed"));
    actor.send({ type: "description.change", description: "Changed" });
    expect(actor.getSnapshot().context.description).toBe("First");

    actor.send({ type: "share.publish" });
    await waitFor(actor, isSettled);

    expect(fetchMock).toHaveBeenCalledTimes(2);

    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(`${origin}/api/playgrounds/${linkId}`);
      expect(readJsonBody(init as RequestInit)).toMatchObject({ description: "First" });
    }

    expect(actor.getSnapshot().context.result?.link.id).toBe(linkId);
    expect(await links.shareLink("project-1")).toMatchObject({ linkId });
  });

  it("should report a published link this browser could not keep", async () => {
    const frozen = makeSnapshot();
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(makePublished(frozen)));
    const links = new VolatileProjectStorage();
    vi.spyOn(links, "saveShareLink").mockRejectedValue(new Error("quota"));
    const actor = await start(frozen, { fetch: fetchMock, links });
    const saved = collectSavedRecords(actor);

    actor.send({ type: "visibility.change", visibility: "link" });
    actor.send({ type: "consent.change", consent: true });
    actor.send({ type: "share.publish" });
    await waitFor(actor, isSettled);

    expect(actor.getSnapshot().context.result?.linkSaved).toBe(false);
    expect(saved).toEqual([]);
  });

  it("should open on the push step for a shared project when asked, and on the form for a new one", async () => {
    const shared = await start(makeSnapshot(), { link: existing, openPushStep: false, startView: "push" });
    const unshared = await start(makeSnapshot(), { startView: "push" });

    expect(shared.getSnapshot().value).toBe("preparingPush");
    expect(unshared.getSnapshot().value).toBe("ready");
  });

  it("should start a first share in Community, and a shared link where it stands", async () => {
    const fresh = await start(makeSnapshot());
    const linkOnly = await start(makeSnapshot(), { link: existing, openPushStep: false });
    const listed = await start(makeSnapshot(), {
      link: { ...existing, listing: { topic: "bug-repros" } },
      openPushStep: false,
    });

    expect(fresh.getSnapshot().context).toMatchObject({ visibility: "community", topic: "playground" });
    expect(linkOnly.getSnapshot().context).toMatchObject({ visibility: "link", topic: "playground" });
    expect(listed.getSnapshot().context).toMatchObject({ visibility: "community", topic: "bug-repros" });
  });

  it("should list a first Community share in the same step, with its topic and description", async () => {
    const frozen = makeSnapshot();
    const links = new VolatileProjectStorage();
    const services = makeMockServices(frozen);
    const actor = await start(frozen, { services, links });

    actor.send({ type: "topic.change", topic: "bug-repros" });
    actor.send({ type: "description.change", description: "  Soft deletes  " });
    actor.send({ type: "consent.change", consent: true });
    actor.send({ type: "share.publish" });
    await waitFor(actor, isSettled);

    expect(services.community.listShareInCommunity).toHaveBeenCalledWith({
      linkId,
      choice: { topic: "bug-repros", description: "Soft deletes" },
      signal: expect.any(AbortSignal),
    });
    expect(actor.getSnapshot().context.result?.listingError).toBeUndefined();
    expect(await links.shareLink("project-1")).toMatchObject({
      description: "Soft deletes",
      listing: { topic: "bug-repros", description: "Soft deletes" },
    });
  });

  it("should keep a published link unlisted and say why when Community refuses it", async () => {
    const frozen = makeSnapshot();
    const links = new VolatileProjectStorage();
    const services = makeMockServices(frozen);
    services.community.listShareInCommunity.mockRejectedValue(new Error("Community is closed."));
    const actor = await start(frozen, { services, links });

    actor.send({ type: "consent.change", consent: true });
    actor.send({ type: "share.publish" });
    await waitFor(actor, isSettled);

    expect(actor.getSnapshot().context.result).toMatchObject({ linkSaved: true, listingError: "Community is closed." });
    expect(await links.shareLink("project-1")).toMatchObject({ linkId });
    expect((await links.shareLink("project-1"))?.listing).toBeUndefined();
  });

  it("should make a link only without touching Community", async () => {
    const frozen = makeSnapshot();
    const links = new VolatileProjectStorage();
    const services = makeMockServices(frozen);
    const actor = await start(frozen, { services, links });

    actor.send({ type: "visibility.change", visibility: "link" });
    actor.send({ type: "consent.change", consent: true });
    actor.send({ type: "share.publish" });
    await waitFor(actor, isSettled);

    expect(services.community.listShareInCommunity).not.toHaveBeenCalled();
    expect((await links.shareLink("project-1"))?.listing).toBeUndefined();
  });

  it("should push to a listed link without touching Community while its description stays", async () => {
    const frozen = makeSnapshot();
    const links = new VolatileProjectStorage();
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(makePublished(frozen)));
    const actor = await start(frozen, { fetch: fetchMock, link: existing, links, openPushStep: false });
    const listedHere: ShareLinkRecord = {
      ...existing,
      description: "Same words",
      listing: { topic: "bug-repros", description: "Same words" },
    };

    actor.send({ type: "link.change", record: listedHere });
    actor.send({ type: "push.open" });
    expect(actor.getSnapshot().context).toMatchObject({ description: "Same words" });
    actor.send({ type: "consent.change", consent: true });
    actor.send({ type: "share.publish" });
    await waitFor(actor, isSettled);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${origin}/api/playgrounds/${linkId}`]);
    expect(await links.shareLink("project-1")).toMatchObject({
      description: "Same words",
      listing: { topic: "bug-repros", description: "Same words" },
    });
  });

  it("should carry a new description to a listed link's Community card, keeping its topic", async () => {
    const frozen = makeSnapshot();
    const links = new VolatileProjectStorage();
    const services = makeMockServices(frozen);
    const actor = await start(frozen, {
      services,
      links,
      link: { ...existing, description: "Old words", listing: { topic: "bug-repros", description: "Old words" } },
    });

    actor.send({ type: "description.change", description: "New words" });
    actor.send({ type: "consent.change", consent: true });
    actor.send({ type: "share.publish" });
    await waitFor(actor, isSettled);

    expect(services.playgrounds.publishPlaygroundSnapshot).not.toHaveBeenCalled();
    expect(services.community.listShareInCommunity).toHaveBeenCalledWith({
      linkId,
      choice: { topic: "bug-repros", description: "New words" },
      signal: expect.any(AbortSignal),
    });
    expect(await links.shareLink("project-1")).toMatchObject({
      description: "New words",
      listing: { topic: "bug-repros", description: "New words" },
    });
  });

  it("should publish and record through the injected services, each with the actor's abort signal", async () => {
    const frozen = makeSnapshot();
    const recording = makeRecording(frozen);
    const services = makeMockServices(frozen);
    const actor = await start(frozen, { services, recording });

    actor.send({ type: "consent.change", consent: true });
    actor.send({ type: "share.publish" });
    await waitFor(actor, isSettled);

    expect(services.playgrounds.publishPlaygroundSnapshot).toHaveBeenCalledWith({
      snapshot: frozen,
      description: "",
      idempotencyKey: key,
      signal: expect.any(AbortSignal),
    });
    expect(services.community.listShareInCommunity).toHaveBeenCalledWith({
      linkId,
      choice: { topic: "playground", description: "" },
      signal: expect.any(AbortSignal),
    });
    expect(services.recordedRuns.recordRun).toHaveBeenCalledWith({
      linkId,
      recording,
      signal: expect.any(AbortSignal),
    });
    expect(services.playgrounds.pushChanges).not.toHaveBeenCalled();
  });
});

describe("share publication actor, recorded run", () => {
  it("should send an offered recording to the link", async () => {
    const frozen = makeSnapshot();
    const recording = makeRecording(frozen);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(makePublished(frozen)))
      .mockResolvedValueOnce(makeResponse({ recordedAt: recording.recordedAt }));
    const actor = await start(frozen, { fetch: fetchMock, link: existing, recording });

    actor.send({ type: "consent.change", consent: true });
    actor.send({ type: "share.publish" });
    await waitFor(actor, isSettled);

    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toBe(`${origin}/api/playgrounds/${linkId}/recording`);
    expect((init as RequestInit).method).toBe("PUT");
    expect(readJsonBody(init as RequestInit)).toEqual(recording);
  });

  it("should keep the pushed link when the recording fails, and retry only the recording", async () => {
    const frozen = makeSnapshot();
    const recording = makeRecording(frozen);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(makePublished(frozen)))
      .mockResolvedValueOnce(makeResponse({ error: { code: "recording_storage_unavailable" } }, 503))
      .mockResolvedValueOnce(makeResponse({ recordedAt: recording.recordedAt }));
    const actor = await start(frozen, { fetch: fetchMock, link: existing, recording });
    const finished = countFinishedPushes(actor);

    actor.send({ type: "consent.change", consent: true });
    actor.send({ type: "share.publish" });
    await waitFor(actor, (state) => state.matches({ published: "failed" }));

    expect(actor.getSnapshot().context.recordingError).toContain("unavailable");
    expect(finished.count).toBe(0);
    actor.send({ type: "share.publish" });
    expect(actor.getSnapshot().value).toEqual({ published: "failed" });

    actor.send({ type: "recording.retry" });
    await waitFor(actor, isSettled);
    expect(fetchMock.mock.calls.filter(([url]) => url === `${origin}/api/playgrounds/${linkId}`)).toHaveLength(1);
    expect(actor.getSnapshot().context.recordingError).toBe("");
    expect(finished.count).toBe(1);
  });

  it("should ignore a recording retry before anything was published", async () => {
    const actor = await start(makeSnapshot());

    actor.send({ type: "recording.retry" });

    expect(actor.getSnapshot().value).toBe("ready");
  });
});
