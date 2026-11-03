import {
  createRecordedRun,
  digestPlaygroundSnapshot,
  safeParseRecordedRun,
  type PlaygroundSnapshot,
  type RecordedRun,
  type RunResult,
} from "@drizzle-run/core/contracts";
import { fakeRunResult, legacyGuest, projectManifest } from "@drizzle-run/test-fixtures";
import { describe, expect, it } from "vitest";

import { getTestSessionCookie, seedTestSession } from "../test/worker/sessions";
import { SqliteD1 } from "../test/worker/sqlite-d1";
import { fetchWorker } from "../test/worker/worker-app";
import { createD1CommunityRepository } from "./community-repository";
import type { RateLimitBinding, WorkerEnvironment } from "./platform";
import { measureStoredBytes, type PlaygroundServices } from "./playgrounds";
import { createD1RecordedRunRepository } from "./recorded-run-repository";
import { type RecordedRunServices } from "./recorded-runs";
import { createD1SessionServices, readSessionUser } from "./session";
import { createD1SnapshotRepository } from "./snapshot-repository";

const ownerCookie = getTestSessionCookie("octocat");
const strangerCookie = getTestSessionCookie("hubot");
const origin = "https://run.test";

function makeSnapshot(query = 'export const rows = "first";\n'): PlaygroundSnapshot {
  return {
    snapshotVersion: 1,
    name: "Recorded example",
    manifest: { ...projectManifest("sqlite"), files: { "schema.ts": "export {};\n", "query.ts": query } },
  };
}

function makeRunResult(label = "Users"): RunResult {
  return fakeRunResult("succeeded", {
    target: { dialect: "sqlite" },
    displays: [{ label, values: [{ type: "primitive", value: 1 }] }],
    timings: { total: 120 },
  });
}

function makeRecording({
  snapshot = makeSnapshot(),
  label,
}: { snapshot?: PlaygroundSnapshot; label?: string } = {}): RecordedRun {
  const created = createRecordedRun({
    result: makeRunResult(label),
    guests: [legacyGuest()],
    snapshotDigest: digestPlaygroundSnapshot(snapshot),
    recordedAt: "2026-10-17T10:00:00.000Z",
  });

  if (created.status !== "recorded") {
    throw new Error(`Expected a recording, but got '${created.status}'`);
  }

  return created.recording;
}

function createPlaygroundServices(): PlaygroundServices {
  let nextId = 0;

  return {
    newId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
    now: () => "2026-10-17T10:00:00.000Z",
    repository: createD1SnapshotRepository,
    listings: createD1CommunityRepository,
    currentUser: (request, environment) => readSessionUser(request, environment, createD1SessionServices()),
  };
}

const recordedRunServices: RecordedRunServices = {
  parseRecording: safeParseRecordedRun,
  now: () => "2026-10-17T10:05:00.000Z",
  recordings: createD1RecordedRunRepository,
  snapshots: createD1SnapshotRepository,
  currentUser: (request, environment) => readSessionUser(request, environment, createD1SessionServices()),
};

/** A D1 database with the link owner `octocat` and a stranger `hubot` signed in. */
function makeEnvironment(database: SqliteD1, rateLimit?: RateLimitBinding): WorkerEnvironment {
  seedTestSession(database);
  seedTestSession(database, { login: "hubot", githubId: 480938 });

  return {
    PLAYGROUNDS: database,
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
    ...(rateLimit === undefined ? {} : { PUBLISH_RATE_LIMIT: rateLimit }),
  };
}

function makeRecordRequest({
  id,
  body,
  cookie = ownerCookie,
  requestOrigin = origin,
}: {
  id: string;
  body: unknown;
  cookie?: string | null;
  requestOrigin?: string;
}): Request {
  return new Request(`${origin}/api/playgrounds/${id}/recording`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      origin: requestOrigin,
      "sec-fetch-site": requestOrigin === origin ? "same-origin" : "cross-site",
      ...(cookie === null ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
}

function makeReadRequest(id: string): Request {
  return new Request(`${origin}/api/playgrounds/${id}/recording`);
}

/** Push `snapshot` to the link as its owner, as the Share dialog does. */
async function pushSnapshot(
  environment: WorkerEnvironment,
  services: PlaygroundServices,
  id: string,
  snapshot: PlaygroundSnapshot,
): Promise<Response> {
  return fetchWorker(
    new Request(`${origin}/api/playgrounds/${id}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin,
        "sec-fetch-site": "same-origin",
        cookie: ownerCookie,
      },
      body: JSON.stringify({ snapshot, description: null }),
    }),
    environment,
    { playgrounds: services },
  );
}

async function publishLink(environment: WorkerEnvironment, services = createPlaygroundServices()): Promise<string> {
  const response = await fetchWorker(
    new Request(`${origin}/api/playgrounds`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "publish-key-0000001",
        origin,
        "sec-fetch-site": "same-origin",
        cookie: ownerCookie,
      },
      body: JSON.stringify({ snapshot: makeSnapshot(), description: null }),
    }),
    environment,
    { playgrounds: services },
  );
  const published: unknown = await response.json();

  if (typeof published !== "object" || published === null || !("id" in published)) {
    throw new TypeError("Expected a published link.");
  }

  return String(published.id);
}

async function readErrorCode(response: Response): Promise<string> {
  const body: unknown = await response.json();

  return typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "code" in body.error
    ? String(body.error.code)
    : "";
}

describe("recordRun", () => {
  it("should store a run of the link's snapshot and serve it back, revalidated", async () => {
    const environment = makeEnvironment(new SqliteD1());
    const id = await publishLink(environment);
    const recording = makeRecording();

    const stored = await fetchWorker(makeRecordRequest({ id, body: recording }), environment, {
      recordedRuns: recordedRunServices,
    });
    const read = await fetchWorker(makeReadRequest(id), environment, { recordedRuns: recordedRunServices });

    expect(stored.status).toBe(200);
    expect(await stored.json()).toEqual({ recordedAt: "2026-10-17T10:00:00.000Z" });
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-cache");
    expect(await read.json()).toEqual({ recording });

    const cached = await fetchWorker(
      new Request(makeReadRequest(id), { headers: { "if-none-match": read.headers.get("etag") ?? "" } }),
      environment,
      { recordedRuns: recordedRunServices },
    );

    expect(cached.status).toBe(304);
  });

  it("should accept the same recording again and refuse a different one for the same code", async () => {
    const environment = makeEnvironment(new SqliteD1());
    const id = await publishLink(environment);
    const recording = makeRecording();

    await fetchWorker(makeRecordRequest({ id, body: recording }), environment, { recordedRuns: recordedRunServices });
    const replay = await fetchWorker(makeRecordRequest({ id, body: recording }), environment, {
      recordedRuns: recordedRunServices,
    });
    const other = await fetchWorker(makeRecordRequest({ id, body: makeRecording({ label: "Other" }) }), environment, {
      recordedRuns: recordedRunServices,
    });

    expect(replay.status).toBe(200);
    expect(other.status).toBe(409);
    expect(await readErrorCode(other)).toBe("recording_exists");
  });

  it("should refuse a run of other code than the link shows", async () => {
    const environment = makeEnvironment(new SqliteD1());
    const id = await publishLink(environment);
    const recording = makeRecording({ snapshot: makeSnapshot("export const rows = 'edited';\n") });

    const response = await fetchWorker(makeRecordRequest({ id, body: recording }), environment, {
      recordedRuns: recordedRunServices,
    });

    expect(response.status).toBe(409);
    expect(await readErrorCode(response)).toBe("recording_digest_mismatch");
  });

  it("should drop the run of the old code on a push, and take one of the new code", async () => {
    const environment = makeEnvironment(new SqliteD1());
    const services = createPlaygroundServices();
    const id = await publishLink(environment, services);
    const edited = makeSnapshot("export const rows = 'second';\n");
    await fetchWorker(makeRecordRequest({ id, body: makeRecording() }), environment, {
      recordedRuns: recordedRunServices,
    });

    const pushed = await pushSnapshot(environment, services, id, edited);
    const afterPush = await fetchWorker(makeReadRequest(id), environment, { recordedRuns: recordedRunServices });
    const recorded = await fetchWorker(
      makeRecordRequest({ id, body: makeRecording({ snapshot: edited }) }),
      environment,
      { recordedRuns: recordedRunServices },
    );
    const read = await fetchWorker(makeReadRequest(id), environment, { recordedRuns: recordedRunServices });

    expect(pushed.status).toBe(200);
    expect(afterPush.status).toBe(404);
    expect(await readErrorCode(afterPush)).toBe("recording_not_found");
    expect(recorded.status).toBe(200);
    expect(await read.json()).toEqual({ recording: makeRecording({ snapshot: edited }) });
  });

  it("should store nothing when a push replaced the code before the recording landed", async () => {
    const database = new SqliteD1();
    const environment = makeEnvironment(database);
    const services = createPlaygroundServices();
    const id = await publishLink(environment, services);
    const racingServices: RecordedRunServices = {
      ...recordedRunServices,
      recordings: (recordingsDatabase) => {
        const repository = createD1RecordedRunRepository(recordingsDatabase);

        return {
          ...repository,
          insertIfNew: async (recording) => {
            await pushSnapshot(environment, services, id, makeSnapshot("export const rows = 'pushed';\n"));

            return repository.insertIfNew(recording);
          },
        };
      },
    };

    const response = await fetchWorker(makeRecordRequest({ id, body: makeRecording() }), environment, {
      recordedRuns: racingServices,
    });

    expect(response.status).toBe(409);
    expect(await readErrorCode(response)).toBe("recording_digest_mismatch");
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM recorded_runs").get()).toEqual({ count: 0 });
  });

  it("should need the link's owner, signed in, from the app's own origin", async () => {
    const environment = makeEnvironment(new SqliteD1());
    const id = await publishLink(environment);
    const body = makeRecording();

    const missing = await fetchWorker(makeRecordRequest({ id, body, cookie: null }), environment, {
      recordedRuns: recordedRunServices,
    });
    const wrong = await fetchWorker(makeRecordRequest({ id, body, cookie: strangerCookie }), environment, {
      recordedRuns: recordedRunServices,
    });
    const crossSite = await fetchWorker(
      makeRecordRequest({ id, body, requestOrigin: "https://blog.test" }),
      environment,
      { recordedRuns: recordedRunServices },
    );

    expect([missing.status, wrong.status, crossSite.status]).toEqual([401, 403, 403]);
    expect(await readErrorCode(missing)).toBe("sign_in_required");
    expect(await readErrorCode(wrong)).toBe("not_link_owner");
  });

  it("should reject an invalid recording with its issues", async () => {
    const environment = makeEnvironment(new SqliteD1());
    const id = await publishLink(environment);
    const recording = makeRecording();

    const response = await fetchWorker(
      makeRecordRequest({ id, body: { ...recording, result: { ...recording.result, outcome: "failed" } } }),
      environment,
      { recordedRuns: recordedRunServices },
    );

    expect(response.status).toBe(422);
    expect(await readErrorCode(response)).toBe("invalid_recording");
  });

  it("should refuse a body past the size cap before parsing it", async () => {
    const environment = makeEnvironment(new SqliteD1());
    const id = await publishLink(environment);
    const recording = makeRecording();
    const display = { label: "x".repeat(300 * 1024), values: [] };
    const oversized = { ...recording, result: { ...recording.result, displays: [display] } };

    const response = await fetchWorker(makeRecordRequest({ id, body: oversized }), environment, {
      recordedRuns: recordedRunServices,
    });

    expect(response.status).toBe(413);
    expect(await readErrorCode(response)).toBe("recording_too_large");
  });

  it("should count recordings under their own rate limit key, for the owner's account", async () => {
    const keys: string[] = [];
    const environment = makeEnvironment(new SqliteD1(), {
      async limit({ key }) {
        keys.push(key);
        return { success: !key.startsWith("record:") };
      },
    });
    const id = await publishLink(environment);
    const request = makeRecordRequest({ id, body: makeRecording() });
    request.headers.set("cf-connecting-ip", "203.0.113.7");

    const response = await fetchWorker(request, environment, { recordedRuns: recordedRunServices });

    expect(response.status).toBe(429);
    expect(keys.at(-1)).toBe("record:user:00000000-0000-4000-9000-000000583231");
  });
});

describe("readRecordedRun", () => {
  it("should refuse a stored recording whose payload no longer matches its digest", async () => {
    const database = new SqliteD1();
    const environment = makeEnvironment(database);
    const id = await publishLink(environment);
    await fetchWorker(makeRecordRequest({ id, body: makeRecording() }), environment, {
      recordedRuns: recordedRunServices,
    });
    database.sqlite
      .prepare("UPDATE recorded_runs SET payload_json = ? WHERE link_id = ?")
      .run(JSON.stringify({ ...makeRecording(), snapshotDigest: "b".repeat(64) }), id);

    const response = await fetchWorker(makeReadRequest(id), environment, { recordedRuns: recordedRunServices });

    expect(response.status).toBe(500);
    expect(await readErrorCode(response)).toBe("recording_integrity_error");
  });

  it("should answer 404 for a malformed id and a link without a recording", async () => {
    const environment = makeEnvironment(new SqliteD1());

    const badId = await fetchWorker(makeReadRequest("nope"), environment, { recordedRuns: recordedRunServices });
    const missing = await fetchWorker(makeReadRequest("00000000-0000-4000-8000-000000000001"), environment, {
      recordedRuns: recordedRunServices,
    });

    expect([badId.status, missing.status]).toEqual([404, 404]);
  });
});

describe("recorded runs and the stored publish total", () => {
  it("should count a first recording only, and pause recording once the total is full", async () => {
    const database = new SqliteD1();
    const publishOnly = makeEnvironment(database);
    const id = await publishLink(publishOnly);
    const recording = makeRecording();
    const recordingBytes = measureStoredBytes({
      texts: [JSON.stringify(recording), recording.snapshotDigest],
      rows: 1,
    });
    const spentBytes = (): number =>
      Number(database.sqlite.prepare("SELECT bytes FROM publish_storage WHERE scope = 'everyone'").get()?.bytes ?? 0);
    const publishedBytes = spentBytes();
    const environment: WorkerEnvironment = {
      ...publishOnly,
      PUBLISH_MAX_STORED_BYTES: String(publishedBytes + recordingBytes),
    };

    const first = await fetchWorker(makeRecordRequest({ id, body: recording }), environment, {
      recordedRuns: recordedRunServices,
    });
    const retry = await fetchWorker(makeRecordRequest({ id, body: recording }), environment, {
      recordedRuns: recordedRunServices,
    });

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(spentBytes()).toBe(publishedBytes + recordingBytes);

    const paused = await fetchWorker(
      makeRecordRequest({ id, body: recording }),
      { ...environment, PUBLISH_MAX_STORED_BYTES: "0" },
      { recordedRuns: recordedRunServices },
    );

    expect(paused.status).toBe(200);
  });

  it("should spend the budget once when the same recording arrives twice at the same time", async () => {
    const database = new SqliteD1();
    const environment = makeEnvironment(database);
    const id = await publishLink(environment);
    const recording = makeRecording();
    const recordingBytes = measureStoredBytes({
      texts: [JSON.stringify(recording), recording.snapshotDigest],
      rows: 1,
    });
    const spentBytes = (): number =>
      Number(database.sqlite.prepare("SELECT bytes FROM publish_storage WHERE scope = 'everyone'").get()?.bytes ?? 0);
    const publishedBytes = spentBytes();

    const bothLooked = Promise.withResolvers<void>();
    let lookups = 0;
    const racingServices: RecordedRunServices = {
      ...recordedRunServices,
      recordings: (recordingsDatabase) => {
        const repository = createD1RecordedRunRepository(recordingsDatabase);

        return {
          ...repository,
          find: async (linkId) => {
            const found = await repository.find(linkId);

            if (lookups < 2) {
              lookups += 1;

              if (lookups === 2) {
                bothLooked.resolve();
              }

              await bothLooked.promise;
            }

            return found;
          },
        };
      },
    };

    const answers = await Promise.all([
      fetchWorker(makeRecordRequest({ id, body: recording }), environment, { recordedRuns: racingServices }),
      fetchWorker(makeRecordRequest({ id, body: recording }), environment, { recordedRuns: racingServices }),
    ]);

    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect(spentBytes()).toBe(publishedBytes + recordingBytes);
  });

  it("should keep a recording's bytes counted when storing it throws, since the row may have landed", async () => {
    const database = new SqliteD1();
    const environment = makeEnvironment(database);
    const id = await publishLink(environment);
    const recording = makeRecording();
    const readStoredBytes = (): number =>
      Number(database.sqlite.prepare("SELECT bytes FROM publish_storage WHERE scope = 'everyone'").get()?.bytes ?? 0);
    const publishedBytes = readStoredBytes();
    const failingServices: RecordedRunServices = {
      ...recordedRunServices,
      recordings: (recordingsDatabase) => ({
        ...createD1RecordedRunRepository(recordingsDatabase),
        insertIfNew: async () => {
          throw new Error("D1 timed out after the write");
        },
      }),
    };

    const response = await fetchWorker(makeRecordRequest({ id, body: recording }), environment, {
      recordedRuns: failingServices,
    });

    expect(response.status).toBe(503);
    expect(readStoredBytes()).toBe(
      publishedBytes + measureStoredBytes({ texts: [JSON.stringify(recording), recording.snapshotDigest], rows: 1 }),
    );
  });

  it("should refuse a new recording with publish_storage_full once the stored total is full", async () => {
    const database = new SqliteD1();
    const environment = makeEnvironment(database);
    const id = await publishLink(environment);
    const storedBytes = Number(
      database.sqlite.prepare("SELECT bytes FROM publish_storage WHERE scope = 'everyone'").get()?.bytes ?? 0,
    );

    const response = await fetchWorker(
      makeRecordRequest({ id, body: makeRecording() }),
      { ...environment, PUBLISH_MAX_STORED_BYTES: String(storedBytes) },
      { recordedRuns: recordedRunServices },
    );

    expect(storedBytes).toBeGreaterThan(0);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "publish_storage_full" } });
  });
});
