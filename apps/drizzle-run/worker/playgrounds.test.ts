import {
  canonicalRetiredPairSnapshot,
  digestPlaygroundSnapshot,
  digestRetiredPairSnapshot,
  MAX_PLAYGROUND_SNAPSHOT_BYTES,
  parsePlaygroundSnapshot,
  type PlaygroundSnapshot,
} from "@drizzle-run/core/contracts";
import { isPlainObject } from "es-toolkit";
import { assert, describe, expect, it } from "vitest";

import { getTestSessionCookie, seedTestSession } from "../test/worker/sessions";
import { SqliteD1 } from "../test/worker/sqlite-d1";
import { fetchWorker } from "../test/worker/worker-app";
import { createD1CommunityRepository } from "./community-repository";
import type { WorkerEnvironment } from "./platform";
import {
  listingTextRoomBytes,
  measureStoredBytes,
  newLinkRowsBytes,
  storedRowOverheadBytes,
  type PlaygroundServices,
} from "./playgrounds";
import { createD1SessionServices, readSessionUser } from "./session";
import { createD1SnapshotRepository, type StoredPlaygroundLink } from "./snapshot-repository";

function makeSnapshotInput(): PlaygroundSnapshot {
  return {
    snapshotVersion: 1,
    name: "Shareable example",
    manifest: {
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect: "sqlite" },
      dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
      files: { "schema.ts": "export {};\n" },
      entrypoints: { schema: "schema.ts", run: "schema.ts" },
    },
  };
}

function createServices(): PlaygroundServices {
  let nextId = 0;
  return {
    newId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
    now: () => "2026-10-11T10:00:00.000Z",
    repository: createD1SnapshotRepository,
    listings: createD1CommunityRepository,
    currentUser: (request, environment) => readSessionUser(request, environment, createD1SessionServices()),
  };
}

/** A D1 database where the link owner `octocat` is signed in. */
function makeEnvironment(database: SqliteD1): WorkerEnvironment {
  seedTestSession(database);

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
  };
}

/** The cookie of `octocat`, who publishes every link unless a test signs in someone else. */
const ownerCookie = getTestSessionCookie("octocat");
const ownerUserId = "00000000-0000-4000-9000-000000583231";

/** A new link's publish request: the snapshot wrapped with its description, as the Share dialog sends it. */
function publishRequest(
  snapshot: unknown,
  key = "retry-key-00000001",
  origin = "https://run.test",
  cookie: string | null = ownerCookie,
  description: unknown = null,
): Request {
  return new Request("https://run.test/api/playgrounds", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
      origin,
      "sec-fetch-site": "same-origin",
      ...(cookie === null ? {} : { cookie }),
    },
    body: JSON.stringify({ snapshot, description }),
  });
}

/** A push request: the snapshot wrapped with its description, as the Share dialog sends it. */
function makePushRequest(id: string, body: unknown, cookie: string | null = ownerCookie): Request {
  return new Request(`https://run.test/api/playgrounds/${id}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      origin: "https://run.test",
      "sec-fetch-site": "same-origin",
      ...(cookie === null ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
}

function makeEditedSnapshot(): PlaygroundSnapshot {
  const snapshot = makeSnapshotInput();
  snapshot.manifest.files["schema.ts"] = "export const edited = true;\n";

  return snapshot;
}

async function publishLink(env: WorkerEnvironment, services: PlaygroundServices, cookie?: string): Promise<string> {
  const request = publishRequest(makeSnapshotInput());
  const response = await fetchWorker(cookie === undefined ? request : withCookie(request, cookie), env, {
    playgrounds: services,
  });
  return String((await readJsonObject(response)).id);
}

/** A link stored as is, without the publish route's checks. */
function insertStoredRow(
  database: SqliteD1,
  row: Pick<
    StoredPlaygroundLink,
    "id" | "snapshotVersion" | "payloadJson" | "contentDigest" | "createdAt" | "idempotencyKey"
  >,
): void {
  database.sqlite
    .prepare(`
    INSERT INTO playground_links (id, owner_user_id, snapshot_version, payload_json, content_digest, summary_json, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      row.id,
      ownerUserId,
      row.snapshotVersion,
      row.payloadJson,
      row.contentDigest,
      JSON.stringify({ files: {} }),
      row.idempotencyKey,
      row.createdAt,
      row.createdAt,
    );
}

/** The ETag of a link's read, as the Worker writes it for an unlisted link. */
function toLinkEtag(digest: string, updatedAt = "2026-10-11T10:00:00.000Z"): string {
  return `"sha256-${digest}-u${Date.parse(updatedAt)}"`;
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();

  if (!isRecord(value)) {
    throw new TypeError("Expected a JSON object response.");
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

describe("Cloudflare playground snapshot routes", () => {
  it("should publish once, return the same record for concurrent retries, and read it immediately", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const services = createServices();
    const input = makeSnapshotInput();
    const [first, replay] = await Promise.all([
      fetchWorker(publishRequest(input), env, { playgrounds: services }),
      fetchWorker(publishRequest(input), env, { playgrounds: services }),
    ]);
    const firstBody = await readJsonObject(first);
    const replayBody = await readJsonObject(replay);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replayBody.id).toBe(firstBody.id);
    const id = String(firstBody.id);
    const loaded = await fetchWorker(new Request(`https://run.test/api/playgrounds/${id}`), env, {
      playgrounds: services,
    });
    const loadedBody = await readJsonObject(loaded);
    expect(loaded.status).toBe(200);
    expect(loaded.headers.get("etag")).toBe(toLinkEtag(digestPlaygroundSnapshot(input)));
    expect(loaded.headers.get("cache-control")).toBe("no-cache");
    expect(loadedBody.snapshot).toEqual(parsePlaygroundSnapshot(input));
    expect(loadedBody).toMatchObject({ updatedAt: "2026-10-11T10:00:00.000Z", description: null, community: null });
    expect(firstBody).toEqual({
      id,
      digest: digestPlaygroundSnapshot(input),
      updatedAt: "2026-10-11T10:00:00.000Z",
      url: `/s/${id}`,
      embedUrl: `/embed/${id}`,
    });
    const cached = await fetchWorker(
      new Request(`https://run.test/api/playgrounds/${id}`, {
        headers: { "if-none-match": `W/${toLinkEtag(digestPlaygroundSnapshot(input))}` },
      }),
      env,
      { playgrounds: services },
    );
    expect(cached.status).toBe(304);
  });

  it("should reject a reused key with changed content and reject cross-origin publishing", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const services = createServices();
    await fetchWorker(publishRequest(makeSnapshotInput()), env, { playgrounds: services });
    const changed = makeSnapshotInput();
    changed.name = "Changed name";
    const conflict = await fetchWorker(publishRequest(changed), env, { playgrounds: services });
    const crossOrigin = await fetchWorker(
      publishRequest(makeSnapshotInput(), "retry-key-00000002", "https://attacker.test"),
      env,
      { playgrounds: services },
    );
    expect(conflict.status).toBe(409);
    expect((await readJsonObject(conflict)).error).toMatchObject({ code: "idempotency_key_conflict" });
    expect(crossOrigin.status).toBe(403);
  });

  it("should refuse a malformed idempotency key with its own code", async () => {
    const env = makeEnvironment(new SqliteD1());
    const services = createServices();

    const malformedIdempotencyKey = await fetchWorker(publishRequest(makeSnapshotInput(), "short"), env, {
      playgrounds: services,
    });

    expect(malformedIdempotencyKey.status).toBe(400);
    expect((await readJsonObject(malformedIdempotencyKey)).error).toMatchObject({ code: "invalid_idempotency_key" });
  });

  it("should refuse a snapshot past 1 MiB of canonical JSON as too large", async () => {
    const database = new SqliteD1();
    const snapshot = makeSnapshotInput();
    const oversized = {
      ...snapshot,
      manifest: { ...snapshot.manifest, files: { "schema.ts": "x".repeat(MAX_PLAYGROUND_SNAPSHOT_BYTES) } },
    };

    const response = await fetchWorker(publishRequest(oversized), makeEnvironment(database), {
      playgrounds: createServices(),
    });

    expect(response.status).toBe(413);
    expect((await readJsonObject(response)).error).toMatchObject({ code: "snapshot_too_large" });
  });

  it("should bound streamed request bodies, reject unsupported versions, and apply configured rate limits", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const services = createServices();
    const oversized = new Request("https://run.test/api/playgrounds", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "retry-key-00000003",
        origin: "https://run.test",
        cookie: ownerCookie,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(600_000));
          controller.enqueue(new Uint8Array(600_000));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const tooLarge = await fetchWorker(oversized, env, { playgrounds: services });
    const unsupported = await fetchWorker(publishRequest({ snapshotVersion: 2 }), env, { playgrounds: services });
    const limitedEnv = makeEnvironment(database);
    limitedEnv.PUBLISH_RATE_LIMIT = {
      async limit() {
        return { success: false };
      },
    };
    const limited = await fetchWorker(publishRequest(makeSnapshotInput(), "retry-key-00000004"), limitedEnv, {
      playgrounds: services,
    });
    expect(tooLarge.status).toBe(413);
    expect(unsupported.status).toBe(422);
    expect((await readJsonObject(unsupported)).error).toMatchObject({ code: "unsupported_version" });
    expect(limited.status).toBe(429);
  });

  it("should report a release pair the catalog does not admit as an invalid snapshot, not an unknown version", async () => {
    const env = makeEnvironment(new SqliteD1());
    const input = makeSnapshotInput();
    const unadmittedPair = {
      ...input,
      manifest: { ...input.manifest, dependencies: { "drizzle-orm": "0.0.1", "drizzle-kit": "0.0.1" } },
    };

    const response = await fetchWorker(publishRequest(unadmittedPair, "retry-key-00000099"), env, {
      playgrounds: createServices(),
    });

    expect(response.status).toBe(422);
    expect((await readJsonObject(response)).error).toMatchObject({
      code: "invalid_snapshot",
      issues: expect.arrayContaining([expect.objectContaining({ code: "UNSUPPORTED_COMBINATION" })]),
    });
  });

  it("should return distinct responses for malformed JSON, invalid snapshots, and unknown manifest versions", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const services = createServices();
    const malformed = new Request("https://run.test/api/playgrounds", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "retry-key-00000005",
        origin: "https://run.test",
        cookie: ownerCookie,
      },
      body: "not JSON",
    });
    const invalid = await fetchWorker(
      publishRequest({ ...makeSnapshotInput(), name: " " }, "retry-key-00000006"),
      env,
      { playgrounds: services },
    );
    const unsupportedManifest = {
      ...makeSnapshotInput(),
      manifest: { ...makeSnapshotInput().manifest, manifestVersion: 2 },
    };
    const unsupported = await fetchWorker(publishRequest(unsupportedManifest, "retry-key-00000007"), env, {
      playgrounds: services,
    });
    const malformedResponse = await fetchWorker(malformed, env, { playgrounds: services });
    expect(malformedResponse.status).toBe(400);
    expect((await readJsonObject(malformedResponse)).error).toMatchObject({ code: "invalid_json" });
    expect(invalid.status).toBe(422);
    expect((await readJsonObject(invalid)).error).toMatchObject({
      code: "invalid_snapshot",
      issues: expect.arrayContaining([
        expect.objectContaining({ path: expect.any(Array), message: expect.any(String) }),
      ]),
    });
    expect(unsupported.status).toBe(422);
    expect((await readJsonObject(unsupported)).error).toMatchObject({ code: "unsupported_version" });
  });

  it("should return a typed not-found error for a missing link", async () => {
    const missing = await fetchWorker(
      new Request("https://run.test/api/playgrounds/00000000-0000-4000-8000-999999999999"),
      makeEnvironment(new SqliteD1()),
      { playgrounds: createServices() },
    );

    expect(missing.status).toBe(404);
  });

  it("should serve a snapshot on a removed pair as published", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const id = "00000000-0000-4000-8000-000000000042";
    const published = {
      snapshotVersion: 1 as const,
      name: "Old pair",
      manifest: { ...makeSnapshotInput().manifest, dependencies: { "drizzle-orm": "0.44.0", "drizzle-kit": "0.30.0" } },
    };
    const row = {
      id,
      snapshotVersion: 1,
      payloadJson: canonicalRetiredPairSnapshot(published),
      contentDigest: digestRetiredPairSnapshot(published),
      createdAt: "2026-01-01T00:00:00.000Z",
      idempotencyKey: "retired-key-000001",
    };
    insertStoredRow(database, row);

    const loaded = await fetchWorker(new Request(`https://run.test/api/playgrounds/${id}`), env, {
      playgrounds: createServices(),
    });

    expect(loaded.status).toBe(200);
    expect(await readJsonObject(loaded)).toEqual({
      snapshot: published,
      digest: row.contentDigest,
      updatedAt: row.createdAt,
      description: null,
      community: null,
    });
  });

  it("should return bounded storage errors without exposing SQL or request contents", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const base = createServices();
    const services: PlaygroundServices = {
      ...base,
      repository: () => ({
        async insertLinkIfNew() {
          throw new Error("SQL details must not be returned");
        },
        async findByIdempotencyKey() {
          return null;
        },
        async findLink() {
          throw new Error("SQL details must not be returned");
        },
        async pushSnapshot() {
          throw new Error("SQL details must not be returned");
        },
        async reservePublishBytes() {
          return true;
        },
        async releasePublishBytes() {},
        async deleteLink() {
          throw new Error("SQL details must not be returned");
        },
      }),
    };
    const request = await fetchWorker(publishRequest(makeSnapshotInput()), env, { playgrounds: services });
    const load = await fetchWorker(
      new Request("https://run.test/api/playgrounds/00000000-0000-4000-8000-999999999999"),
      env,
      { playgrounds: services },
    );
    expect(request.status).toBe(503);
    expect(load.status).toBe(503);
    expect(JSON.stringify(await readJsonObject(request))).not.toContain("SQL details");
    expect(JSON.stringify(await readJsonObject(load))).not.toContain("SQL details");
  });
});

const pairSnapshot = (query: string): PlaygroundSnapshot => ({
  snapshotVersion: 1,
  name: "Both sides",
  manifest: {
    kind: "drizzle-run-pair",
    manifestVersion: 1,
    entrypoints: { schema: "schema.ts", run: "query.ts" },
    files: {},
    sides: [
      {
        target: { dialect: "sqlite" },
        dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
        files: { "schema.ts": "export {};\n", "query.ts": "export {};\n" },
      },
      {
        target: { dialect: "sqlite" },
        dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
        files: { "schema.ts": "export {};\n", "query.ts": query },
      },
    ],
  },
});

describe("pushing changes", () => {
  it("should refuse to publish a link signed out", async () => {
    const database = new SqliteD1();

    const response = await fetchWorker(
      publishRequest(makeSnapshotInput(), "signed-out-key-0001", "https://run.test", null),
      makeEnvironment(database),
      { playgrounds: createServices() },
    );

    expect(response.status).toBe(401);
    expect((await readJsonObject(response)).error).toMatchObject({ code: "sign_in_required" });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM playground_links").get()).toEqual({ count: 0 });
  });

  it("should push changes to the same link, which shows them at once", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const owner = seedTestSession(database);
    const services = createServices();
    const id = await publishLink(env, services, owner.cookie);

    const pushed = await fetchWorker(makePushRequest(id, { snapshot: makeEditedSnapshot() }), env, {
      playgrounds: services,
    });
    const loaded = await fetchWorker(new Request(`https://run.test/api/playgrounds/${id}`), env, {
      playgrounds: services,
    });

    expect(pushed.status).toBe(200);
    expect(await readJsonObject(pushed)).toMatchObject({
      id,
      digest: digestPlaygroundSnapshot(makeEditedSnapshot()),
      url: `/s/${id}`,
    });
    expect(loaded.headers.get("etag")).toBe(toLinkEtag(digestPlaygroundSnapshot(makeEditedSnapshot())));
    expect(await readJsonObject(loaded)).toMatchObject({ snapshot: parsePlaygroundSnapshot(makeEditedSnapshot()) });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM playground_links").get()).toEqual({ count: 1 });
  });

  it("should push a side-by-side snapshot", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const owner = seedTestSession(database);
    const services = createServices();
    const id = String(
      (
        await readJsonObject(
          await fetchWorker(withCookie(publishRequest(pairSnapshot("export {};\n")), owner.cookie), env, {
            playgrounds: services,
          }),
        )
      ).id,
    );

    const pushed = await fetchWorker(makePushRequest(id, { snapshot: pairSnapshot("export const next = 1;\n") }), env, {
      playgrounds: services,
    });

    expect(pushed.status).toBe(200);
    expect(await readLatest(env, id, services)).toMatchObject({
      snapshot: parsePlaygroundSnapshot(pairSnapshot("export const next = 1;\n")),
    });
  });

  it("should reject a signed-out push, another account's push, and an unknown link", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const stranger = seedTestSession(database, { login: "stranger", githubId: 42 });
    const services = createServices();
    const id = await publishLink(env, services);
    const body = { snapshot: makeEditedSnapshot() };

    const missing = await fetchWorker(makePushRequest(id, body, null), env, { playgrounds: services });
    const wrong = await fetchWorker(makePushRequest(id, body, stranger.cookie), env, { playgrounds: services });
    const notFound = await fetchWorker(makePushRequest("00000000-0000-4000-8000-999999999999", body), env, {
      playgrounds: services,
    });

    expect(missing.status).toBe(401);
    expect((await readJsonObject(missing)).error).toMatchObject({ code: "sign_in_required" });
    expect(wrong.status).toBe(403);
    expect((await readJsonObject(wrong)).error).toMatchObject({ code: "not_link_owner" });
    expect(notFound.status).toBe(404);
    expect((await readLatest(env, id, services)).digest).toBe(digestPlaygroundSnapshot(makeSnapshotInput()));
  });

  it("should answer a push of what the link already shows, and its concurrent retry, without storing anything", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const services = createServices();
    const id = await publishLink(env, services);
    const bytesBefore = readStoredBytes(database);

    const [first, retry] = await Promise.all([
      fetchWorker(makePushRequest(id, { snapshot: makeSnapshotInput() }), env, { playgrounds: services }),
      fetchWorker(makePushRequest(id, { snapshot: makeSnapshotInput() }), env, { playgrounds: services }),
    ]);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect((await readJsonObject(first)).digest).toBe(digestPlaygroundSnapshot(makeSnapshotInput()));
    expect(readStoredBytes(database)).toBe(bytesBefore);
  });

  it("should reject another account's publish that reuses a first publish's idempotency key", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const stranger = seedTestSession(database, { login: "stranger", githubId: 42 });
    const services = createServices();
    await fetchWorker(publishRequest(makeSnapshotInput()), env, { playgrounds: services });

    const retry = await fetchWorker(
      publishRequest(makeSnapshotInput(), "retry-key-00000001", "https://run.test", stranger.cookie),
      env,
      { playgrounds: services },
    );

    expect(retry.status).toBe(409);
  });
});

async function readLatest(env: WorkerEnvironment, id: string, services: PlaygroundServices) {
  return readJsonObject(
    await fetchWorker(new Request(`https://run.test/api/playgrounds/${id}`), env, { playgrounds: services }),
  );
}

describe("share descriptions", () => {
  it("should keep a new link's description on one line, and none when it is empty", async () => {
    const env = makeEnvironment(new SqliteD1());
    const services = createServices();

    const described = await fetchWorker(
      publishRequest(makeSnapshotInput(), undefined, undefined, undefined, "  Hide deleted\n rows   by default. "),
      env,
      { playgrounds: services },
    );
    const bare = await fetchWorker(
      publishRequest(makeSnapshotInput(), "retry-key-00000002", undefined, undefined, "   "),
      env,
      { playgrounds: services },
    );
    const describedId = String((await readJsonObject(described)).id);
    const bareId = String((await readJsonObject(bare)).id);

    expect(described.status).toBe(200);
    expect(bare.status).toBe(200);
    expect(await readLatest(env, describedId, services)).toMatchObject({
      description: "Hide deleted rows by default.",
    });
    expect(await readLatest(env, bareId, services)).toMatchObject({ description: null });
  });

  it("should refuse a description with a control character as invalid, not as a failure to retry", async () => {
    const env = makeEnvironment(new SqliteD1());

    const refused = await fetchWorker(
      publishRequest(makeSnapshotInput(), undefined, undefined, undefined, "\u0000Hide deleted rows."),
      env,
      { playgrounds: createServices() },
    );

    expect(refused.status).toBe(422);
  });

  it("should push a new description with the same code, and keep the recorded run", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const services = createServices();
    const id = await publishLink(env, services);
    insertRecording(database, id);

    const pushed = await fetchWorker(
      makePushRequest(id, { snapshot: makeSnapshotInput(), description: "Now described." }),
      env,
      { playgrounds: services },
    );

    expect(pushed.status).toBe(200);
    expect(await readLatest(env, id, services)).toMatchObject({ description: "Now described." });
    expect(countShareRows(database, id)).toMatchObject({ recordings: 1 });
  });

  it("should reject a bare snapshot, a description that is not text or is too long, and a reused key with another description", async () => {
    const bareEnv = makeEnvironment(new SqliteD1());
    const bare = await fetchWorker(
      new Request("https://run.test/api/playgrounds", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "retry-key-00000009",
          origin: "https://run.test",
          cookie: ownerCookie,
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify([makeSnapshotInput()]),
      }),
      bareEnv,
      { playgrounds: createServices() },
    );
    expect(bare.status).toBe(422);
    expect((await readJsonObject(bare)).error).toMatchObject({ code: "invalid_share" });

    const env = makeEnvironment(new SqliteD1());
    const services = createServices();

    const long = await fetchWorker(
      publishRequest(makeSnapshotInput(), "retry-key-00000003", undefined, undefined, "x".repeat(141)),
      env,
      { playgrounds: services },
    );
    const notText = await fetchWorker(
      publishRequest(makeSnapshotInput(), "retry-key-00000004", undefined, undefined, 3),
      env,
      { playgrounds: services },
    );
    await fetchWorker(publishRequest(makeSnapshotInput(), "retry-key-00000005", undefined, undefined, "First"), env, {
      playgrounds: services,
    });
    const reused = await fetchWorker(
      publishRequest(makeSnapshotInput(), "retry-key-00000005", undefined, undefined, "Second"),
      env,
      { playgrounds: services },
    );

    expect(long.status).toBe(422);
    expect(notText.status).toBe(422);
    expect(reused.status).toBe(409);
  });
});

/** The request as sent from one IPv6 address. */
function fromNetwork(request: Request): Request {
  request.headers.set("cf-connecting-ip", "2001:db8:85a3:42::1");
  return request;
}

function withCookie(request: Request, cookie: string): Request {
  const headers = new Headers(request.headers);
  headers.set("cookie", cookie);
  return new Request(request, { headers });
}

function readOwner(database: SqliteD1, id: string): unknown {
  return (
    database.sqlite.prepare("SELECT owner_user_id FROM playground_links WHERE id = ?").get(id) as
      | { owner_user_id: unknown }
      | undefined
  )?.owner_user_id;
}

describe("owned links", () => {
  it("should rate limit publishes and pushes per account, with Retry-After", async () => {
    const database = new SqliteD1();
    const keys: string[] = [];
    const env: WorkerEnvironment = {
      ...makeEnvironment(database),
      PUBLISH_RATE_LIMIT: {
        async limit({ key }) {
          keys.push(key);
          return { success: false };
        },
      },
    };
    const services = createServices();
    const owner = seedTestSession(database);

    const signedIn = await fetchWorker(
      fromNetwork(withCookie(publishRequest(makeSnapshotInput(), "owned-key-00000009"), owner.cookie)),
      env,
      { playgrounds: services },
    );
    const linkId = "00000000-0000-4000-8000-000000000999";
    const push = await fetchWorker(fromNetwork(withCookie(makePushRequest(linkId, {}, null), owner.cookie)), env, {
      playgrounds: services,
    });

    expect(signedIn.status).toBe(429);
    expect(signedIn.headers.get("retry-after")).toBe("60");
    expect(push.status).toBe(429);
    expect(keys).toEqual([`publish:user:${owner.userId}`, `publish:user:${owner.userId}`]);
  });

  it("should answer a publish whose session cannot be read with a retryable 503", async () => {
    const services: PlaygroundServices = {
      ...createServices(),
      currentUser: async () => {
        throw new Error("D1 is unavailable");
      },
    };

    const response = await fetchWorker(publishRequest(makeSnapshotInput()), makeEnvironment(new SqliteD1()), {
      playgrounds: services,
    });

    expect(response.status).toBe(503);
    expect(await readJsonObject(response)).toMatchObject({ error: { code: "session_unavailable" } });
  });

  it("should record the signed-in owner of a new link", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const services = createServices();
    const owner = seedTestSession(database);

    const owned = await fetchWorker(
      withCookie(publishRequest(makeSnapshotInput(), "owned-key-00000001"), owner.cookie),
      env,
      { playgrounds: services },
    );

    expect(readOwner(database, String((await readJsonObject(owned)).id))).toBe(owner.userId);
  });

  it("should let the owner push changes from any signed-in browser, and no one else", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const services = createServices();
    const owner = seedTestSession(database);
    const stranger = seedTestSession(database, { login: "stranger", githubId: 42 });
    const published = await fetchWorker(
      withCookie(publishRequest(makeSnapshotInput(), "owned-key-00000002"), owner.cookie),
      env,
      { playgrounds: services },
    );
    const id = String((await readJsonObject(published)).id);
    const body = { snapshot: makeEditedSnapshot(), description: "From my laptop" };

    const byOwner = await fetchWorker(withCookie(makePushRequest(id, body, null), owner.cookie), env, {
      playgrounds: services,
    });
    const byStranger = await fetchWorker(withCookie(makePushRequest(id, body, null), stranger.cookie), env, {
      playgrounds: services,
    });
    const signedOut = await fetchWorker(makePushRequest(id, body, null), env, { playgrounds: services });

    expect(byOwner.status).toBe(200);
    expect(await readJsonObject(byOwner)).toMatchObject({ digest: digestPlaygroundSnapshot(makeEditedSnapshot()) });
    expect(byStranger.status).toBe(403);
    expect(signedOut.status).toBe(401);
  });

  it("should treat an expired session as signed out", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const services = createServices();
    const owner = seedTestSession(database);
    const published = await fetchWorker(
      withCookie(publishRequest(makeSnapshotInput(), "owned-key-00000003"), owner.cookie),
      env,
      { playgrounds: services },
    );
    const id = String((await readJsonObject(published)).id);
    database.sqlite.prepare("UPDATE sessions SET expires_at = ?").run("2026-01-01T00:00:00.000Z");

    const response = await fetchWorker(
      withCookie(makePushRequest(id, { snapshot: makeEditedSnapshot() }, null), owner.cookie),
      env,
      { playgrounds: services },
    );

    expect(response.status).toBe(401);
    expect(database.sqlite.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
  });

  it("should tell only the signed-in owner that they own a link", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const services = createServices();
    const owner = seedTestSession(database);
    const stranger = seedTestSession(database, { login: "stranger", githubId: 42 });
    const published = await fetchWorker(
      withCookie(publishRequest(makeSnapshotInput(), "owned-key-00000004"), owner.cookie),
      env,
      { playgrounds: services },
    );
    const id = String((await readJsonObject(published)).id);
    const ownershipRequest = new Request(`https://run.test/api/playgrounds/${id}/ownership`);

    const asOwner = await fetchWorker(withCookie(ownershipRequest, owner.cookie), env, { playgrounds: services });
    const asStranger = await fetchWorker(withCookie(ownershipRequest, stranger.cookie), env, { playgrounds: services });
    const signedOut = await fetchWorker(ownershipRequest, env, { playgrounds: services });
    const unknown = await fetchWorker(
      new Request("https://run.test/api/playgrounds/00000000-0000-4000-8000-00000000ffff/ownership"),
      env,
      { playgrounds: services },
    );

    expect(await asOwner.json()).toEqual({ owned: true });
    expect(asOwner.headers.get("cache-control")).toBe("no-store");
    expect(await asStranger.json()).toEqual({ owned: false });
    expect(await signedOut.json()).toEqual({ owned: false });
    expect(unknown.status).toBe(404);
  });
});

function makeStoredCapEnvironment(database: SqliteD1, capBytes: number): WorkerEnvironment {
  return { ...makeEnvironment(database), PUBLISH_MAX_STORED_BYTES: String(capBytes) };
}

/** The bytes shares and recorded runs keep in total, or null before the first publish. */
function readStoredBytes(database: SqliteD1): unknown {
  const row = database.sqlite.prepare("SELECT bytes FROM publish_storage WHERE scope = 'everyone'").get();

  return row?.bytes ?? null;
}

/** What a first publish of `snapshot` counts, measured by publishing it once into a scratch database. */
async function measureFirstPublishBytes(snapshot = makeSnapshotInput()): Promise<number> {
  const database = new SqliteD1();
  await fetchWorker(publishRequest(snapshot), makeStoredCapEnvironment(database, 1024 * 1024), {
    playgrounds: createServices(),
  });

  return Number(readStoredBytes(database));
}

describe("stored publish total", () => {
  it("should count every stored byte of a first publish: the payload, its summary, the listing room and each row", async () => {
    const database = new SqliteD1();
    const encoder = new TextEncoder();

    await fetchWorker(publishRequest(makeSnapshotInput()), makeStoredCapEnvironment(database, 1024 * 1024), {
      playgrounds: createServices(),
    });
    const stored = database.sqlite.prepare("SELECT payload_json, summary_json FROM playground_links").get();
    assert(typeof stored?.payload_json === "string" && typeof stored.summary_json === "string");

    expect(Number(readStoredBytes(database))).toBe(
      encoder.encode(stored.payload_json).byteLength +
        encoder.encode(stored.summary_json).byteLength +
        encoder.encode(JSON.stringify(["schema.ts"])).byteLength +
        2 * storedRowOverheadBytes +
        listingTextRoomBytes,
    );
    expect(listingTextRoomBytes).toBe((160 + 140 + 2 * 40) * 4);
  });

  it("should count a first publish once, not its retry", async () => {
    const database = new SqliteD1();
    const env = makeStoredCapEnvironment(database, 1024 * 1024);
    const services = createServices();
    const snapshotBytes = await measureFirstPublishBytes();

    await fetchWorker(publishRequest(makeSnapshotInput()), env, { playgrounds: services });
    await fetchWorker(publishRequest(makeSnapshotInput()), env, { playgrounds: services });

    expect(readStoredBytes(database)).toBe(snapshotBytes);
  });

  it("should keep a publish's bytes counted when storing it throws, since the row may have landed", async () => {
    const database = new SqliteD1();
    const env = makeStoredCapEnvironment(database, 1024 * 1024);
    const snapshotBytes = await measureFirstPublishBytes();
    const services: PlaygroundServices = {
      ...createServices(),
      repository: (playgrounds) => ({
        ...createD1SnapshotRepository(playgrounds),
        async insertLinkIfNew() {
          throw new Error("D1 timed out after the write");
        },
      }),
    };

    const response = await fetchWorker(publishRequest(makeSnapshotInput()), env, { playgrounds: services });

    expect(response.status).toBe(503);
    expect(readStoredBytes(database)).toBe(snapshotBytes);
  });

  it("should count a push's snapshot and give back the one it replaced", async () => {
    const database = new SqliteD1();
    const env = makeStoredCapEnvironment(database, 1024 * 1024);
    const services = createServices();
    const editedBytes = await measureFirstPublishBytes(makeEditedSnapshot());
    const id = await publishLink(env, services);

    const pushed = await fetchWorker(makePushRequest(id, { snapshot: makeEditedSnapshot() }), env, {
      playgrounds: services,
    });

    expect(pushed.status).toBe(200);
    expect(readStoredBytes(database)).toBe(editedBytes);
  });

  it("should keep a push's bytes counted when storing it throws, since the row may have landed", async () => {
    const database = new SqliteD1();
    const env = makeStoredCapEnvironment(database, 1024 * 1024);
    const id = await publishLink(env, createServices());
    const publishedBytes = Number(readStoredBytes(database));
    const services: PlaygroundServices = {
      ...createServices(),
      repository: (playgrounds) => ({
        ...createD1SnapshotRepository(playgrounds),
        async pushSnapshot() {
          throw new Error("D1 timed out after the write");
        },
      }),
    };

    const response = await fetchWorker(makePushRequest(id, { snapshot: makeEditedSnapshot() }), env, {
      playgrounds: services,
    });

    expect(response.status).toBe(503);
    expect(Number(readStoredBytes(database))).toBeGreaterThan(publishedBytes);
  });

  it.each(["before", "after"] as const)(
    "should keep other shares' bytes counted when deletion runs %s the push transaction",
    async (deletionOrder) => {
      const database = new SqliteD1();
      const env = makeStoredCapEnvironment(database, 1024 * 1024);
      const base = createServices();
      const other = await publishLink(env, base);
      const otherBytes = readStoredBytes(database);
      const published = await fetchWorker(publishRequest(makeSnapshotInput(), "racing-share-key-01"), env, {
        playgrounds: base,
      });
      const id = String((await readJsonObject(published)).id);
      const repository = createD1SnapshotRepository(database);
      const counted = { rowOverheadBytes: storedRowOverheadBytes, linkBytes: newLinkRowsBytes };
      const services: PlaygroundServices = {
        ...base,
        repository: () => ({
          ...repository,
          async pushSnapshot(...args) {
            if (deletionOrder === "before") {
              await repository.deleteLink(id, counted);
            }

            const updated = await repository.pushSnapshot(...args);

            if (deletionOrder === "after") {
              await repository.deleteLink(id, counted);
            }

            return updated;
          },
        }),
      };

      const response = await fetchWorker(makePushRequest(id, { snapshot: makeEditedSnapshot() }), env, {
        playgrounds: services,
      });

      expect(response.status).toBe(404);
      expect(readStoredBytes(database)).toBe(otherBytes);
      expect(countShareRows(database, id)).toEqual({ links: 0, recordings: 0, listings: 0 });
      expect(countShareRows(database, other)).toEqual({ links: 1, recordings: 0, listings: 0 });
    },
  );

  it("should pause publishing once the stored total is full, and keep earlier links open", async () => {
    const database = new SqliteD1();
    const services = createServices();
    const snapshotBytes = await measureFirstPublishBytes();
    const env = makeStoredCapEnvironment(database, snapshotBytes);
    const id = await publishLink(env, services);

    const second = await fetchWorker(publishRequest(makeSnapshotInput(), "stored-key-000001"), env, {
      playgrounds: services,
    });
    const push = await fetchWorker(makePushRequest(id, { snapshot: makeEditedSnapshot() }), env, {
      playgrounds: services,
    });

    expect(second.status).toBe(503);
    expect(second.headers.get("Retry-After")).toBeNull();
    expect((await readJsonObject(second)).error).toMatchObject({ code: "publish_storage_full" });
    expect(push.status).toBe(503);
    expect(readStoredBytes(database)).toBe(snapshotBytes);
    expect(
      (await fetchWorker(new Request(`https://run.test/api/playgrounds/${id}`), env, { playgrounds: services })).status,
    ).toBe(200);
  });

  it("should pause every publish when the cap is 0", async () => {
    const response = await fetchWorker(
      publishRequest(makeSnapshotInput()),
      makeStoredCapEnvironment(new SqliteD1(), 0),
      { playgrounds: createServices() },
    );

    expect(response.status).toBe(503);
  });
});

function deleteShareRequest(id: string, cookie: string | null = ownerCookie, origin = "https://run.test"): Request {
  return new Request(`https://run.test/api/playgrounds/${id}`, {
    method: "DELETE",
    headers: { origin, ...(cookie === null ? {} : { cookie }) },
  });
}

/** The rows a share keeps in each table it owns. */
function countShareRows(database: SqliteD1, id: string): Record<string, unknown> {
  const count = (query: string) => database.sqlite.prepare(query).get(id)?.count;

  return {
    links: count("SELECT COUNT(*) AS count FROM playground_links WHERE id = ?"),
    recordings: count("SELECT COUNT(*) AS count FROM recorded_runs WHERE link_id = ?"),
    listings: count("SELECT COUNT(*) AS count FROM community_listings WHERE link_id = ?"),
  };
}

/** A Community listing with two reports, as listing it and reporting it would leave it. */
function insertListing(database: SqliteD1, linkId: string, listingOwnerId: string): void {
  database.sqlite
    .prepare(`
    INSERT INTO community_listings (link_id, owner_user_id, state, title, topic, dialect, orm_version, kit_version, guest_flavor, file_names, listed_at, report_count, last_reported_at)
    VALUES (?, ?, 'listed', 'Shareable example', 'playground', 'sqlite', '0.45.4', '0.31.11', 'slim', '["schema.ts"]', ?, 2, ?)
  `)
    .run(linkId, listingOwnerId, "2026-10-11T10:00:00.000Z", "2026-10-12T10:00:00.000Z");
}

/** A recorded run of the link's current snapshot, counted in the stored total as `recordRun` counts it. */
function insertRecording(database: SqliteD1, linkId: string): void {
  const stored = database.sqlite.prepare("SELECT content_digest FROM playground_links WHERE id = ?").get(linkId);
  assert(typeof stored?.content_digest === "string");
  const payloadJson = JSON.stringify({ output: "Résultat ✓" });

  database.sqlite
    .prepare(`
    INSERT INTO recorded_runs (link_id, snapshot_digest, payload_json, recorded_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `)
    .run(linkId, stored.content_digest, payloadJson, "2026-10-11T10:00:00.000Z", "2026-10-11T10:00:00.000Z");
  database.sqlite
    .prepare("UPDATE publish_storage SET bytes = bytes + ? WHERE scope = 'everyone'")
    .run(measureStoredBytes({ texts: [payloadJson, stored.content_digest], rows: 1 }));
}

describe("deleting a share", () => {
  it("should refuse a cross-origin, signed-out or stranger's deletion and change nothing", async () => {
    const database = new SqliteD1();
    const env = makeStoredCapEnvironment(database, 1024 * 1024);
    const services = createServices();
    const stranger = seedTestSession(database, { login: "stranger", githubId: 42 });
    const id = await publishLink(env, services);
    const storedBytes = readStoredBytes(database);

    const crossOrigin = await fetchWorker(deleteShareRequest(id, ownerCookie, "https://attacker.test"), env, {
      playgrounds: services,
    });
    const signedOut = await fetchWorker(deleteShareRequest(id, null), env, { playgrounds: services });
    const byStranger = await fetchWorker(deleteShareRequest(id, stranger.cookie), env, { playgrounds: services });

    expect(crossOrigin.status).toBe(403);
    expect((await readJsonObject(crossOrigin)).error).toMatchObject({ code: "same_origin_required" });
    expect(signedOut.status).toBe(401);
    expect(byStranger.status).toBe(403);
    expect((await readJsonObject(byStranger)).error).toMatchObject({ code: "not_link_owner" });
    expect(countShareRows(database, id)).toEqual({ links: 1, recordings: 0, listings: 0 });
    expect(readStoredBytes(database)).toBe(storedBytes);
    expect(
      (await fetchWorker(new Request(`https://run.test/api/playgrounds/${id}`), env, { playgrounds: services })).status,
    ).toBe(200);
  });

  it("should delete a share with its recorded run and reported listing, give back its bytes and keep other shares", async () => {
    const database = new SqliteD1();
    const env = makeStoredCapEnvironment(database, 10 * 1024 * 1024);
    const services = createServices();
    const owner = seedTestSession(database);
    const otherPublished = await fetchWorker(
      withCookie(publishRequest(makeSnapshotInput(), "other-share-key-01"), owner.cookie),
      env,
      { playgrounds: services },
    );
    const other = String((await readJsonObject(otherPublished)).id);
    insertListing(database, other, owner.userId);
    insertRecording(database, other);
    const otherBytes = readStoredBytes(database);

    const published = await fetchWorker(
      withCookie(publishRequest(makeSnapshotInput(), "deleted-share-key-1"), owner.cookie),
      env,
      { playgrounds: services },
    );
    const id = String((await readJsonObject(published)).id);
    insertListing(database, id, owner.userId);
    const pushed = await fetchWorker(
      makePushRequest(id, { snapshot: pairSnapshot("export const next = 1;\n"), description: "Zoë's ünïcode" }),
      env,
      { playgrounds: services },
    );
    insertRecording(database, id);

    const deleted = await fetchWorker(deleteShareRequest(id), env, { playgrounds: services });
    const read = (path: string) =>
      fetchWorker(new Request(`https://run.test/api/playgrounds/${path}`), env, { playgrounds: services });

    expect(pushed.status).toBe(200);
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get("cache-control")).toBe("no-store");
    expect(countShareRows(database, id)).toEqual({ links: 0, recordings: 0, listings: 0 });
    expect(readStoredBytes(database)).toBe(otherBytes);
    expect((await read(id)).status).toBe(404);
    expect((await read(`${id}/recording`)).status).toBe(404);
    expect(countShareRows(database, other)).toEqual({ links: 1, recordings: 1, listings: 1 });
    expect((await read(other)).status).toBe(200);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 1 });
  });

  it("should let the signed-in owner delete from any browser, and give back nothing once the share is gone", async () => {
    const database = new SqliteD1();
    const env = makeStoredCapEnvironment(database, 1024 * 1024);
    const services = createServices();
    const owner = seedTestSession(database);
    const other = await publishLink(env, services);
    const otherBytes = readStoredBytes(database);
    const published = await fetchWorker(
      withCookie(publishRequest(makeSnapshotInput(), "owned-share-key-01"), owner.cookie),
      env,
      { playgrounds: services },
    );
    const id = String((await readJsonObject(published)).id);

    const deleted = await fetchWorker(withCookie(deleteShareRequest(id, null), owner.cookie), env, {
      playgrounds: services,
    });
    const repeated = await fetchWorker(withCookie(deleteShareRequest(id, null), owner.cookie), env, {
      playgrounds: services,
    });
    // A concurrent deletion that passed its owner check before the first one landed.
    await createD1SnapshotRepository(database).deleteLink(id, {
      rowOverheadBytes: storedRowOverheadBytes,
      linkBytes: newLinkRowsBytes,
    });

    expect(deleted.status).toBe(204);
    expect(repeated.status).toBe(404);
    expect((await readJsonObject(repeated)).error).toMatchObject({ code: "playground_not_found" });
    expect(readStoredBytes(database)).toBe(otherBytes);
    expect(countShareRows(database, other)).toEqual({ links: 1, recordings: 0, listings: 0 });
  });
});

describe("pushing to a listed share with a recorded run", () => {
  it("should refresh the listing's copy, delete the run of the old code and give back its bytes", async () => {
    const database = new SqliteD1();
    const env = makeStoredCapEnvironment(database, 10 * 1024 * 1024);
    const services = createServices();
    const owner = seedTestSession(database);
    const id = await publishLink(env, services, owner.cookie);
    insertListing(database, id, owner.userId);
    const editedBytes = await measureFirstPublishBytes(pairSnapshot("export const next = 1;\n"));
    insertRecording(database, id);

    const pushed = await fetchWorker(makePushRequest(id, { snapshot: pairSnapshot("export const next = 1;\n") }), env, {
      playgrounds: services,
    });
    const listing = database.sqlite
      .prepare("SELECT title, second_dialect, file_names, report_count FROM community_listings WHERE link_id = ?")
      .get(id);

    expect(pushed.status).toBe(200);
    expect(countShareRows(database, id)).toEqual({ links: 1, recordings: 0, listings: 1 });
    expect(listing).toEqual({
      title: "Both sides",
      second_dialect: "sqlite",
      file_names: JSON.stringify(["query.ts", "schema.ts"]),
      report_count: 2,
    });
    expect(readStoredBytes(database)).toBe(editedBytes);
  });
});
