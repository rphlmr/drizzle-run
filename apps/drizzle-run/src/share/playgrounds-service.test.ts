import { digestPlaygroundSnapshot, digestRetiredPairSnapshot } from "@drizzle-run/core/contracts";
import { describe, expect, it, vi } from "vitest";

import type { Fetch } from "../lib/api";
import { createProject } from "../project/projects";
import { createPlaygroundsService } from "./playgrounds-service";

const origin = "https://run.example.test";
const idempotencyKey = "8e03978e-40d5-43e8-bc93-6894a57f9324";
const details = { description: "Hide deleted rows.", community: null };

function makeSnapshot() {
  const project = createProject("Published", { dialect: "sqlite" });
  return { snapshotVersion: 1 as const, name: project.name, manifest: project.manifest };
}

function makeResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A Worker that answers every request with `body`. */
function answer(body: unknown, status = 200) {
  return vi.fn<Fetch>(async () => makeResponse(body, status));
}

/** A Worker that refuses every request as rate limited, with `retryAfter` as its `Retry-After` when given. */
function answerRateLimited(retryAfter?: string) {
  return vi.fn<Fetch>(
    async () =>
      new Response(JSON.stringify({ error: { code: "rate_limited", message: "Too many." } }), {
        status: 429,
        headers: { "content-type": "application/json", ...(retryAfter ? { "retry-after": retryAfter } : {}) },
      }),
  );
}

function makeService(fetch: Fetch) {
  return createPlaygroundsService({ fetch, origin });
}

/** Publish a new link to a Worker that refuses it as rate limited, with `retryAfter` as its `Retry-After`. */
function publishRateLimited(retryAfter?: string) {
  return makeService(answerRateLimited(retryAfter)).publishPlaygroundSnapshot({
    snapshot: makeSnapshot(),
    description: "",
    idempotencyKey,
    signal: new AbortController().signal,
  });
}

/** A fresh signal, for calls whose cancellation the case does not test. */
function makeSignal() {
  return new AbortController().signal;
}

/** The JSON a mocked `fetch` call sent; a body that is not a string fails the test. */
function readJsonBody(init: RequestInit | undefined): unknown {
  const body = init?.body;

  if (typeof body !== "string") {
    throw new Error(`Expected a JSON string request body, but got ${typeof body}`);
  }

  return JSON.parse(body);
}

function makePublished(value: ReturnType<typeof makeSnapshot>) {
  return {
    id: "snap_123",
    digest: digestPlaygroundSnapshot(value),
    updatedAt: "2026-10-11T00:00:00.000Z",
    url: "/s/snap_123",
    embedUrl: "/embed/snap_123",
  };
}

describe("playgrounds service", () => {
  it("should validate the digest and shape returned by the snapshot endpoint", async () => {
    const value = makeSnapshot();
    const fetchMock = answer({
      snapshot: value,
      digest: digestPlaygroundSnapshot(value),
      updatedAt: "2026-10-11T00:00:00.000Z",
      ...details,
    });

    await expect(
      makeService(fetchMock).getPlaygroundSnapshot({ id: "snap_123", signal: makeSignal() }),
    ).resolves.toMatchObject({ snapshot: value });
    expect(fetchMock).toHaveBeenCalledWith(
      `${origin}/api/playgrounds/snap_123`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("should pass the caller's abort signal to every request", async () => {
    const value = makeSnapshot();
    const signal = makeSignal();
    const fetchMock = vi.fn<Fetch>(async (url) =>
      url.endsWith("/ownership") ? makeResponse({ owned: true }) : makeResponse(makePublished(value)),
    );
    const service = makeService(fetchMock);

    await service.publishPlaygroundSnapshot({ snapshot: value, description: "", idempotencyKey, signal });
    await service.pushChanges({ linkId: "snap_123", snapshot: value, description: "", signal });
    await service.fetchLinkOwnership({ linkId: "snap_123", signal });

    expect(fetchMock).toHaveBeenCalledTimes(3);

    for (const [, init] of fetchMock.mock.calls) {
      expect(init.signal).toBe(signal);
    }
  });

  it("should name an unavailable service, not the connection, when a proxy answers a 502 page", async () => {
    const fetchMock = vi.fn<Fetch>(
      async () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }),
    );

    await expect(
      makeService(fetchMock).getPlaygroundSnapshot({ id: "snap_123", signal: makeSignal() }),
    ).rejects.toThrow("Playground sharing is temporarily unavailable. Retry in a moment.");
  });

  it("should reject as cancelled when the request is aborted while its body is read", async () => {
    const controller = new AbortController();
    const aborted = new DOMException("The operation was aborted.", "AbortError");
    const fetchMock = vi.fn<Fetch>(async () => {
      controller.abort(aborted);

      return Object.assign(makeResponse({}), { json: () => Promise.reject(aborted) });
    });

    await expect(
      makeService(fetchMock).getPlaygroundSnapshot({ id: "snap_123", signal: controller.signal }),
    ).rejects.toBe(aborted);
  });

  it("should say how long to wait when publishing is rate limited", async () => {
    await expect(publishRateLimited("60")).rejects.toThrow(
      "Too many playgrounds were published. Try again in 1 minute.",
    );
    await expect(publishRateLimited("45")).rejects.toThrow("Try again in 45 seconds.");
    await expect(publishRateLimited("soon")).rejects.toThrow("Too many playgrounds were published. Try again shortly.");
    await expect(publishRateLimited()).rejects.toThrow("Too many playgrounds were published. Try again shortly.");
  });

  it("should reject snapshots whose stored content does not match the advertised digest", async () => {
    const fetchMock = answer({
      snapshot: makeSnapshot(),
      digest: "0".repeat(64),
      updatedAt: "2026-10-11T00:00:00.000Z",
      ...details,
    });

    await expect(
      makeService(fetchMock).getPlaygroundSnapshot({ id: "snap_123", signal: makeSignal() }),
    ).rejects.toThrow("failed its integrity check");
  });

  it("should refuse a snapshot response without its description", async () => {
    const value = makeSnapshot();
    const fetchMock = answer({
      snapshot: value,
      digest: digestPlaygroundSnapshot(value),
      updatedAt: "2026-10-11T00:00:00.000Z",
      community: null,
    });

    await expect(
      makeService(fetchMock).getPlaygroundSnapshot({ id: "snap_123", signal: makeSignal() }),
    ).rejects.toThrow("invalid shared playground");
  });

  it("should return a snapshot on a removed pair as published, with its pair", async () => {
    const value = {
      ...makeSnapshot(),
      manifest: { ...makeSnapshot().manifest, dependencies: { "drizzle-orm": "0.44.0", "drizzle-kit": "0.30.0" } },
    };
    const digest = digestRetiredPairSnapshot(value);
    const matching = answer({ snapshot: value, digest, updatedAt: "2026-10-11T00:00:00.000Z", ...details });

    await expect(
      makeService(matching).getPlaygroundSnapshot({ id: "snap_123", signal: makeSignal() }),
    ).resolves.toEqual({
      snapshot: value,
      retiredPair: { target: { dialect: "sqlite" }, releaseLine: "legacy", ormVersion: "0.44.0", kitVersion: "0.30.0" },
      digest,
      updatedAt: "2026-10-11T00:00:00.000Z",
      ...details,
    });

    const tampered = answer({
      snapshot: value,
      digest: "0".repeat(64),
      updatedAt: "2026-10-11T00:00:00.000Z",
      ...details,
    });

    await expect(makeService(tampered).getPlaygroundSnapshot({ id: "snap_123", signal: makeSignal() })).rejects.toThrow(
      "failed its integrity check",
    );
  });

  it("should publish only the captured snapshot with the retry-stable idempotency key", async () => {
    const value = makeSnapshot();
    const fetchMock = answer({
      ...makePublished(value),
      url: `${origin}/s/snap_123`,
      embedUrl: `${origin}/embed/snap_123`,
    });
    const service = makeService(fetchMock);
    const request = { snapshot: value, description: " Hide deleted rows ", idempotencyKey };

    await service.publishPlaygroundSnapshot({ ...request, signal: makeSignal() });
    await service.publishPlaygroundSnapshot({ ...request, signal: makeSignal() });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(`${origin}/api/playgrounds`);
      expect(init.headers).toMatchObject({ "Idempotency-Key": idempotencyKey });
      expect(init.headers).not.toHaveProperty("Authorization");
      expect(readJsonBody(init)).toEqual({ snapshot: value, description: "Hide deleted rows" });
    }
  });

  it("should reject API-provided links that escape the Drizzle Run origin", async () => {
    const value = makeSnapshot();
    const fetchMock = answer({ ...makePublished(value), url: "https://attacker.example/s/snap_123" });

    await expect(
      makeService(fetchMock).publishPlaygroundSnapshot({
        snapshot: value,
        description: "",
        idempotencyKey,
        signal: makeSignal(),
      }),
    ).rejects.toThrow("invalid playground URL");
  });

  it("should refuse a publish response with a missing field", async () => {
    const value = makeSnapshot();
    const { embedUrl: _embedUrl, ...incomplete } = makePublished(value);

    await expect(
      makeService(answer(incomplete)).publishPlaygroundSnapshot({
        snapshot: value,
        description: "",
        idempotencyKey,
        signal: makeSignal(),
      }),
    ).rejects.toThrow("Drizzle Run returned an invalid playground URL.");
  });

  it("should resolve same-origin relative links and translate the Worker error envelope", async () => {
    const value = makeSnapshot();

    await expect(
      makeService(answer(makePublished(value))).publishPlaygroundSnapshot({
        snapshot: value,
        description: "",
        idempotencyKey,
        signal: makeSignal(),
      }),
    ).resolves.toMatchObject({
      url: `${origin}/s/snap_123`,
      embedUrl: `${origin}/embed/snap_123`,
    });

    const unavailable = answer(
      { error: { code: "snapshot_storage_unavailable", message: "sensitive details stay server-side" } },
      503,
    );

    await expect(
      makeService(unavailable).getPlaygroundSnapshot({ id: "snap_123", signal: makeSignal() }),
    ).rejects.toThrow("temporarily unavailable");
  });

  it("should ask a signed-out author to sign in", async () => {
    await expect(
      makeService(answer({ error: { code: "sign_in_required" } }, 401)).publishPlaygroundSnapshot({
        snapshot: makeSnapshot(),
        description: "",
        idempotencyKey,
        signal: makeSignal(),
      }),
    ).rejects.toThrow("Sign in with GitHub to share.");
  });

  it("should push changes with the session alone and no idempotency key", async () => {
    const value = makeSnapshot();
    const fetchMock = answer(makePublished(value));

    await expect(
      makeService(fetchMock).pushChanges({
        linkId: "snap_123",
        snapshot: value,
        description: "  Add posts ",
        signal: makeSignal(),
      }),
    ).resolves.toMatchObject({ id: "snap_123", url: `${origin}/s/snap_123` });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${origin}/api/playgrounds/snap_123`);
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
    });
    expect(readJsonBody(init)).toEqual({ snapshot: value, description: "Add posts" });

    await expect(
      makeService(answer({ error: { code: "not_link_owner" } }, 403)).pushChanges({
        linkId: "snap_123",
        snapshot: value,
        description: "",
        signal: makeSignal(),
      }),
    ).rejects.toThrow("This share belongs to another GitHub account.");
  });

  it("should refuse a push answered for another link", async () => {
    const value = makeSnapshot();

    await expect(
      makeService(
        answer({ ...makePublished(value), id: "snap_456", url: "/s/snap_456", embedUrl: "/embed/snap_456" }),
      ).pushChanges({ linkId: "snap_123", snapshot: value, description: "", signal: makeSignal() }),
    ).rejects.toThrow("invalid playground ID");
  });

  it("should read an unreadable ownership answer as not owned", async () => {
    await expect(
      makeService(answer({ owned: "yes" })).fetchLinkOwnership({ linkId: "snap_123", signal: makeSignal() }),
    ).resolves.toBe(false);
  });
});
