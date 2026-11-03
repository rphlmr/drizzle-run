import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { fetchWorker } from "../test/worker/worker-app";
import { createD1AuthServices } from "./auth";
import { createD1CloudSyncServices } from "./cloud-sync";
import { createD1CommunityServices } from "./community";
import { createD1DocumentServices, resolveDocumentMeta, serveSitemap } from "./document-meta";
import { checkRateLimit } from "./http";
import type { D1Database, WorkerEnvironment } from "./platform";
import { createD1RecordedRunServices } from "./recorded-runs";
import { createD1SessionServices, type ReadCurrentUser, readSessionUser } from "./session";

const linkId = "00000000-0000-4000-8000-000000000001";
const origin = "https://run.test";
const sessionCookie = `__Host-drizzle-run-session=${"t".repeat(43)}`;
const d1Failure = new Error("D1 is unavailable");
const sessionServices = createD1SessionServices();
const currentUser: ReadCurrentUser = (request, environment) => readSessionUser(request, environment, sessionServices);
const authServices = createD1AuthServices();
const cloudSyncServices = createD1CloudSyncServices({ currentUser });
const communityServices = createD1CommunityServices({ currentUser });
const documentServices = createD1DocumentServices();
const recordedRunServices = createD1RecordedRunServices({ currentUser });

/** A D1 whose every statement throws, as during an outage. */
const failingD1: D1Database = {
  prepare() {
    throw d1Failure;
  },
  async batch() {
    throw d1Failure;
  },
};

function makeEnvironment(overrides: Partial<WorkerEnvironment> = {}): WorkerEnvironment {
  return {
    PLAYGROUNDS: failingD1,
    RUNTIME_ASSETS: {
      async get() {
        return null;
      },
    },
    ASSETS: {
      async fetch() {
        return new Response(null, { status: 404 });
      },
    },
    CLOUD_PROJECTS: {
      async get() {
        return null;
      },
      async put() {},
      async delete() {},
    },
    ...overrides,
  };
}

function makeRequest(path: string, init: Omit<RequestInit, "headers"> = {}): Request {
  return new Request(`${origin}${path}`, {
    ...init,
    headers: { origin, cookie: sessionCookie, "content-type": "application/json" },
  });
}

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
});

/** Asserts a logged line that names what failed and carries the cause. */
function expectLoggedFailure(cause: unknown = d1Failure) {
  expect(consoleError).toHaveBeenCalledTimes(1);
  const record = JSON.parse(String(consoleError.mock.calls[0]?.[0]));

  expect(record).toMatchObject({ level: 50, event: expect.stringMatching(/_failed$/), err: expect.any(Object) });
  expect(JSON.stringify(record.err)).toContain(cause instanceof Error ? cause.message : String(cause));
}

describe("worker routes during a D1 outage", () => {
  it.each([
    [
      "the Community list",
      () => fetchWorker(makeRequest("/api/community"), makeEnvironment(), { community: communityServices }),
    ],
    [
      "a Community report",
      () =>
        fetchWorker(makeRequest(`/api/community/${linkId}/report`, { method: "POST" }), makeEnvironment(), {
          community: communityServices,
        }),
    ],
    [
      "an unlist",
      () =>
        fetchWorker(makeRequest(`/api/playgrounds/${linkId}/listing`, { method: "DELETE" }), makeEnvironment(), {
          community: communityServices,
        }),
    ],
    [
      "a recorded run",
      () =>
        fetchWorker(makeRequest(`/api/playgrounds/${linkId}/recording`), makeEnvironment(), {
          recordedRuns: recordedRunServices,
        }),
    ],
    ["the session", () => fetchWorker(makeRequest("/api/auth/session"), makeEnvironment(), { auth: authServices })],
    [
      "a sign out",
      () => fetchWorker(makeRequest("/api/auth/logout", { method: "POST" }), makeEnvironment(), { auth: authServices }),
    ],
    [
      "the cloud status",
      () => fetchWorker(makeRequest("/api/cloud"), makeEnvironment(), { cloudSync: cloudSyncServices }),
    ],
    [
      "a cloud project",
      () =>
        fetchWorker(makeRequest(`/api/cloud/projects/${linkId}`), makeEnvironment(), { cloudSync: cloudSyncServices }),
    ],
    [
      "a cloud save",
      () =>
        fetchWorker(
          makeRequest(`/api/cloud/projects/${linkId}`, { method: "PUT", body: JSON.stringify({ baseRevision: 0 }) }),
          makeEnvironment(),
          { cloudSync: cloudSyncServices },
        ),
    ],
    [
      "a cloud delete",
      () =>
        fetchWorker(
          makeRequest(`/api/cloud/projects/${linkId}?revision=1&digest=${"a".repeat(64)}`, { method: "DELETE" }),
          makeEnvironment(),
          { cloudSync: cloudSyncServices },
        ),
    ],
  ])("should log why %s is unavailable", async (_route, answer) => {
    const response = await answer();

    expect(response.status).toBeGreaterThanOrEqual(500);
    expectLoggedFailure();
    expect(JSON.parse(String(consoleError.mock.calls[0]?.[0]))).toMatchObject({
      request_id: response.headers.get("X-Request-Id"),
      method: expect.any(String),
      path: expect.any(String),
    });
  });

  it("should log why a share page falls back to the generic preview", async () => {
    const meta = await resolveDocumentMeta({ kind: "share", linkId }, makeEnvironment(), documentServices);

    expect(meta.indexable).toBe(false);
    expectLoggedFailure();
  });

  it("should log why the sitemap lists only the static pages", async () => {
    const response = await serveSitemap(origin, makeEnvironment(), documentServices);

    expect(response.status).toBe(200);
    expectLoggedFailure();
  });
});

describe("unexpected request failures", () => {
  it.each([new Error("Private storage failure"), "Unexpected thrown string"])(
    "should return a generic JSON 500 and log one correlated failure for %s",
    async (failure) => {
      const request = makeRequest("/assets/missing.js?token=private");
      const response = await fetchWorker(
        request,
        makeEnvironment({
          ASSETS: {
            async fetch() {
              return Promise.reject(failure);
            },
          },
        }),
      );

      expect(response.status).toBe(500);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({
        error: {
          code: "internal_error",
          message: "An unexpected error occurred. Try again.",
          request_id: response.headers.get("X-Request-Id"),
        },
      });
      expectLoggedFailure(failure);
      expect(JSON.parse(String(consoleError.mock.calls[0]?.[0]))).toMatchObject({
        event: "request_failed",
        request_id: response.headers.get("X-Request-Id"),
        path: "/assets/missing.js",
        method: "GET",
      });
    },
  );

  it("should retain expected client errors without logging them as failures", async () => {
    const response = await fetchWorker(makeRequest("/api/unknown"), makeEnvironment());

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "api_route_not_found" } });
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("worker write routes", () => {
  it.each([
    ["a recording", `/api/playgrounds/${linkId}/recording`],
    ["a Community listing", `/api/playgrounds/${linkId}/listing`],
  ])("should refuse %s from another site as forbidden, whatever its content type", async (_name, path) => {
    const request = new Request(`${origin}${path}`, {
      method: "PUT",
      headers: { origin: "https://elsewhere.test", "content-type": "text/plain" },
      body: "{}",
    });

    const response = await fetchWorker(request, makeEnvironment());

    expect(response.status).toBe(403);
  });
});

describe("checkRateLimit", () => {
  it("should log why the rate limiter is unavailable", async () => {
    const limiterFailure = new Error("The rate limiter is unreachable");
    const environment = makeEnvironment({
      PUBLISH_RATE_LIMIT: {
        async limit() {
          throw limiterFailure;
        },
      },
    });

    const response = await checkRateLimit(makeRequest("/api/playgrounds", { method: "POST" }), environment, "publish");

    expect(response?.status).toBe(503);
    expectLoggedFailure(limiterFailure);
  });
});
