import { digestCloudProject } from "@drizzle-run/core/contracts";
import { describe, expect, it } from "vitest";

import { seedTestSession, type TestSession } from "../test/worker/sessions";
import { SqliteD1 } from "../test/worker/sqlite-d1";
import { fetchWorker } from "../test/worker/worker-app";
import { createD1CloudRepository } from "./cloud-repository";
import { cloudSyncLimits, saveRateLimitRetryAfterMs, type CloudSyncServices } from "./cloud-sync";
import type { CloudProjectBucket, WorkerEnvironment } from "./platform";
import { createD1SessionServices, readSessionUser } from "./session";

const origin = "https://run.test";
const projectId = "123e4567-e89b-42d3-a456-426614174000";

/**
 * An R2 bucket in memory that counts writes
 *
 * `beforePut` runs ahead of each write, so a test can hold saves at that point to interleave them.
 */
function makeMemoryBucket({ beforePut = async () => {} }: { beforePut?: () => Promise<void> } = {}) {
  const objects = new Map<string, string>();
  let puts = 0;
  const bucket: CloudProjectBucket = {
    async put(key, value) {
      await beforePut();
      puts += 1;
      objects.set(key, value);
    },
    async get(key) {
      const value = objects.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    async delete(key) {
      objects.delete(key);
    },
  };

  return { bucket, objects, getPuts: () => puts };
}

function makeEnvironment(database: SqliteD1, options: { bucket?: CloudProjectBucket | null } = {}) {
  const memory = makeMemoryBucket();
  const environment: WorkerEnvironment = {
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
    ...(options.bucket === null ? {} : { CLOUD_PROJECTS: options.bucket ?? memory.bucket }),
  };

  return { environment, memory };
}

/**
 * Services whose saves wait after reading the account totals until `saves` of them have read them, so every save
 * reads the limits before any of them writes.
 */
function makeLockstepServices(saves: number) {
  const { services } = makeServices();
  const allRead = Promise.withResolvers<void>();
  let readers = 0;

  return {
    ...services,
    repository: (database) => {
      const repository = createD1CloudRepository(database);

      return {
        ...repository,
        readTotals: async (userId) => {
          const totals = await repository.readTotals(userId);
          readers += 1;

          if (readers === saves) {
            allRead.resolve();
          }

          await allRead.promise;

          return totals;
        },
      };
    },
  } satisfies CloudSyncServices;
}

/** A new project id for each index, distinct from `projectId`. */
function makeProjectId(index: number) {
  return `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

/** Saves `count` new projects at once, each with its own id. */
function saveNewProjectsAtOnce(
  session: TestSession,
  environment: WorkerEnvironment,
  services: CloudSyncServices,
  count: number,
) {
  return Promise.all(
    Array.from({ length: count }, (_, index) => {
      const id = makeProjectId(index);

      return fetchWorker(
        makeSaveRequest(session, { baseRevision: 0, record: makeRecord({ id }) }, { id }),
        environment,
        { cloudSync: services },
      );
    }),
  );
}

function readSortedStatuses(responses: Response[]) {
  return responses.map((response) => response.status).toSorted((left, right) => left - right);
}

/** Services on a clock the test moves. */
function makeServices(start = "2026-10-17T10:00:00.000Z") {
  let now = new Date(start);
  const services: CloudSyncServices = {
    now: () => now,
    currentUser: (request, environment) => readSessionUser(request, environment, createD1SessionServices()),
    repository: createD1CloudRepository,
  };

  return {
    services,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

function makeRecord({ id = projectId, name = "Soft deletes", query = "export {};\n" } = {}) {
  return {
    version: 1,
    id,
    name,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-17T09:00:00.000Z",
    revision: 3,
    manifest: {
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect: "sqlite" },
      dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
      files: { "schema.ts": "export {};\n", "query.ts": query },
      entrypoints: { schema: "schema.ts", run: "query.ts" },
    },
  };
}

function makeSaveRequest(
  session: TestSession | null,
  body: unknown,
  { id = projectId, requestOrigin = origin }: { id?: string; requestOrigin?: string } = {},
) {
  return new Request(`${origin}/api/cloud/projects/${id}`, {
    method: "PUT",
    headers: {
      origin: requestOrigin,
      "sec-fetch-site": requestOrigin === origin ? "same-origin" : "cross-site",
      "content-type": "application/json",
      ...(session === null ? {} : { cookie: session.cookie }),
    },
    body: JSON.stringify(body),
  });
}

function makeReadRequest(session: TestSession | null, path = "/api/cloud") {
  return new Request(`${origin}${path}`, { headers: session === null ? {} : { cookie: session.cookie } });
}

function makeDeleteRequest(
  session: TestSession,
  { revision, digest }: { revision: number; digest: string },
  requestOrigin = origin,
) {
  const query = new URLSearchParams({ revision: String(revision), digest });

  return new Request(`${origin}/api/cloud/projects/${projectId}?${query}`, {
    method: "DELETE",
    headers: {
      origin: requestOrigin,
      "sec-fetch-site": requestOrigin === origin ? "same-origin" : "cross-site",
      cookie: session.cookie,
    },
  });
}

async function readError(response: Response) {
  return ((await response.json()) as { error: { code: string; retryAfterMs?: number; current?: unknown } }).error;
}

/** Seeds synced projects straight into the index, to reach a limit without saving each one. */
function seedEntries(database: SqliteD1, userId: string, count: number, byteSize: number, firstIndex = 0) {
  for (let index = firstIndex; index < firstIndex + count; index += 1) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    database.sqlite
      .prepare(
        "INSERT INTO cloud_projects" +
          " (user_id, project_id, name, revision, content_digest, byte_size, object_key, created_at, updated_at)" +
          " VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)",
      )
      .run(
        userId,
        id,
        `Seed ${index}`,
        "a".repeat(64),
        byteSize,
        `projects/${userId}/${id}/1-seed.json`,
        "2026-10-01T00:00:00.000Z",
        "2026-10-01T00:00:00.000Z",
      );
  }
}

describe("cloud sync access", () => {
  it("should ask for a sign-in, and say when the deployment has no cloud bucket", async () => {
    const database = new SqliteD1();
    const session = seedTestSession(database);
    const { services } = makeServices();

    const signedOut = await fetchWorker(makeReadRequest(null), makeEnvironment(database).environment, {
      cloudSync: services,
    });
    const unconfigured = await fetchWorker(
      makeReadRequest(session),
      makeEnvironment(database, { bucket: null }).environment,
      { cloudSync: services },
    );

    expect(signedOut.status).toBe(401);
    expect((await readError(signedOut)).code).toBe("sign_in_required");
    expect(unconfigured.status).toBe(503);
    expect((await readError(unconfigured)).code).toBe("cloud_sync_unavailable");
  });

  it("should refuse cross-site saves and deletes", async () => {
    const database = new SqliteD1();
    const session = seedTestSession(database);
    const { environment } = makeEnvironment(database);
    const { services } = makeServices();

    const save = await fetchWorker(
      makeSaveRequest(session, { baseRevision: 0, record: makeRecord() }, { requestOrigin: "https://evil.test" }),
      environment,
      { cloudSync: services },
    );
    const remove = await fetchWorker(
      makeDeleteRequest(session, { revision: 1, digest: "0".repeat(64) }, "https://evil.test"),
      environment,
      { cloudSync: services },
    );

    expect(save.status).toBe(403);
    expect(remove.status).toBe(403);
  });

  it("should keep each account's projects to itself", async () => {
    const database = new SqliteD1();
    const owner = seedTestSession(database);
    const stranger = seedTestSession(database, { login: "stranger", githubId: 42 });
    const { environment } = makeEnvironment(database);
    const { services } = makeServices();
    await fetchWorker(makeSaveRequest(owner, { baseRevision: 0, record: makeRecord() }), environment, {
      cloudSync: services,
    });

    const read = await fetchWorker(makeReadRequest(stranger, `/api/cloud/projects/${projectId}`), environment, {
      cloudSync: services,
    });
    const status = await fetchWorker(makeReadRequest(stranger), environment, { cloudSync: services });

    expect(read.status).toBe(404);
    expect(((await status.json()) as { projects: unknown[] }).projects).toEqual([]);
  });
});

describe("cloud sync saves", () => {
  it("should save a project, list it with its usage, and read it back", async () => {
    const database = new SqliteD1();
    const session = seedTestSession(database);
    const { environment, memory } = makeEnvironment(database);
    const { services } = makeServices();

    const saved = await fetchWorker(makeSaveRequest(session, { baseRevision: 0, record: makeRecord() }), environment, {
      cloudSync: services,
    });
    const status = await fetchWorker(makeReadRequest(session), environment, { cloudSync: services });
    const read = await fetchWorker(makeReadRequest(session, `/api/cloud/projects/${projectId}`), environment, {
      cloudSync: services,
    });

    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ project: { id: projectId, revision: 1 }, unchanged: false });
    expect([...memory.objects.keys()]).toEqual([
      expect.stringMatching(new RegExp(`^projects/${session.userId}/${projectId}/1-[0-9a-f-]{36}\\.json$`)),
    ]);
    expect(await status.json()).toMatchObject({
      githubId: session.githubId,
      limits: cloudSyncLimits,
      usage: { projects: 1 },
      projects: [{ id: projectId, name: "Soft deletes", revision: 1 }],
    });
    expect(await read.json()).toMatchObject({ project: { revision: 1 }, record: makeRecord() });
  });

  it("should keep the official version a project was forked from, and refuse a source that is not one", async () => {
    const database = new SqliteD1();
    const session = seedTestSession(database);
    const { environment } = makeEnvironment(database);
    const { services } = makeServices();
    const forked = { ...makeRecord(), source: { kind: "guide", id: "db0755a7-fec9-4789-a9f7-d9314d0083cc" } };

    const refused = await fetchWorker(
      makeSaveRequest(session, {
        baseRevision: 0,
        record: { ...forked, source: { kind: "guide", id: "transactions" } },
      }),
      environment,
      { cloudSync: services },
    );
    const saved = await fetchWorker(makeSaveRequest(session, { baseRevision: 0, record: forked }), environment, {
      cloudSync: services,
    });
    const read = await fetchWorker(makeReadRequest(session, `/api/cloud/projects/${projectId}`), environment, {
      cloudSync: services,
    });

    expect(refused.status).toBe(422);
    expect(saved.status).toBe(200);
    expect(await read.json()).toMatchObject({ record: forked });
  });

  it("should write nothing for an unchanged project", async () => {
    const database = new SqliteD1();
    const session = seedTestSession(database);
    const { environment, memory } = makeEnvironment(database);
    const { services, advance } = makeServices();
    await fetchWorker(makeSaveRequest(session, { baseRevision: 0, record: makeRecord() }), environment, {
      cloudSync: services,
    });
    advance(10 * 60 * 1000);

    const again = await fetchWorker(
      makeSaveRequest(session, {
        baseRevision: 1,
        record: { ...makeRecord(), updatedAt: "2026-10-17T10:05:00.000Z", revision: 9 },
      }),
      environment,
      { cloudSync: services },
    );

    expect(await again.json()).toMatchObject({ project: { revision: 1 }, unchanged: true });
    expect(memory.getPuts()).toBe(1);
  });

  it("should refuse a save based on an older revision, with the stored one", async () => {
    const database = new SqliteD1();
    const session = seedTestSession(database);
    const { environment } = makeEnvironment(database);
    const { services } = makeServices();
    await fetchWorker(makeSaveRequest(session, { baseRevision: 0, record: makeRecord() }), environment, {
      cloudSync: services,
    });

    const stale = await fetchWorker(
      makeSaveRequest(session, { baseRevision: 0, record: makeRecord({ query: "// other machine\n" }) }),
      environment,
      { cloudSync: services },
    );

    expect(stale.status).toBe(409);
    expect(await readError(stale)).toMatchObject({ code: "cloud_conflict", current: { revision: 1 } });
  });

  it("should refuse a project name with a control character as invalid, not as a failure to retry", async () => {
    const database = new SqliteD1();
    const session = seedTestSession(database);
    const { environment } = makeEnvironment(database);
    const { services } = makeServices();

    const refused = await fetchWorker(
      makeSaveRequest(session, { baseRevision: 0, record: makeRecord({ name: "\u0000Soft deletes" }) }),
      environment,
      { cloudSync: services },
    );

    expect(refused.status).toBe(422);
  });

  it("should refuse a save based on another copy at the same revision, such as one synced again", async () => {
    const database = new SqliteD1();
    const session = seedTestSession(database);
    const { environment } = makeEnvironment(database);
    const { services } = makeServices();
    await fetchWorker(makeSaveRequest(session, { baseRevision: 0, record: makeRecord() }), environment, {
      cloudSync: services,
    });

    const otherCopy = await fetchWorker(
      makeSaveRequest(session, {
        baseRevision: 1,
        baseDigest: "the digest of the copy this machine synced before",
        record: makeRecord({ query: "// other machine\n" }),
      }),
      environment,
      { cloudSync: services },
    );

    expect(otherCopy.status).toBe(409);
    expect(await readError(otherCopy)).toMatchObject({ code: "cloud_conflict", current: { revision: 1 } });
  });

  it("should save a project again right after its last save, and drop the replaced revision", async () => {
    const database = new SqliteD1();
    const session = seedTestSession(database);
    const { environment, memory } = makeEnvironment(database);
    const { services, advance } = makeServices();
    await fetchWorker(makeSaveRequest(session, { baseRevision: 0, record: makeRecord() }), environment, {
      cloudSync: services,
    });
    advance(1_000);

    const again = await fetchWorker(
      makeSaveRequest(session, { baseRevision: 1, record: makeRecord({ query: "// edit\n" }) }),
      environment,
      { cloudSync: services },
    );

    expect(again.status).toBe(200);
    expect([...memory.objects.keys()]).toEqual([
      expect.stringMatching(new RegExp(`^projects/${session.userId}/${projectId}/2-`)),
    ]);
  });

  it("should keep the winner's object when two saves race from the same revision", async () => {
    const database = new SqliteD1();
    const session = seedTestSession(database);
    const bothWriting = Promise.withResolvers<void>();
    let writers = 0;
    const memory = makeMemoryBucket({
      beforePut: async () => {
        writers += 1;

        if (writers === 2) {
          bothWriting.resolve();
        }

        await bothWriting.promise;
      },
    });
    const { environment } = makeEnvironment(database, { bucket: memory.bucket });
    const { services } = makeServices();
    const records = [makeRecord({ query: "// first machine\n" }), makeRecord({ query: "// second machine\n" })];

    const responses = await Promise.all(
      records.map((record) =>
        fetchWorker(makeSaveRequest(session, { baseRevision: 0, record }), environment, { cloudSync: services }),
      ),
    );
    const statuses = responses.map((response) => response.status).toSorted((left, right) => left - right);
    const winner = records[responses.findIndex((response) => response.status === 200)];
    const read = await fetchWorker(makeReadRequest(session, `/api/cloud/projects/${projectId}`), environment, {
      cloudSync: services,
    });

    expect(statuses).toEqual([200, 409]);
    expect(memory.getPuts()).toBe(2);
    expect(memory.objects.size).toBe(1);
    expect(read.status).toBe(200);
    expect(winner).toBeDefined();
    expect(await read.json()).toEqual({
      project: expect.objectContaining({ revision: 1, digest: digestCloudProject(winner ?? records[0]) }),
      record: winner,
    });
  });

  it("should say a cloud copy that is not JSON cannot be read, without asking for a retry", async () => {
    const database = new SqliteD1();
    const session = seedTestSession(database);
    const { environment, memory } = makeEnvironment(database);
    const { services } = makeServices();
    await fetchWorker(makeSaveRequest(session, { baseRevision: 0, record: makeRecord() }), environment, {
      cloudSync: services,
    });

    for (const key of memory.objects.keys()) {
      memory.objects.set(key, '{"version": 1,');
    }

    const read = await fetchWorker(makeReadRequest(session, `/api/cloud/projects/${projectId}`), environment, {
      cloudSync: services,
    });

    expect(read.status).toBe(500);
    expect((await readError(read)).code).toBe("cloud_project_corrupt");
  });

  it("should refuse a project over 1 MB", async () => {
    const database = new SqliteD1();
    const session = seedTestSession(database);
    const { environment, memory } = makeEnvironment(database);
    const { services } = makeServices();

    const response = await fetchWorker(
      makeSaveRequest(session, {
        baseRevision: 0,
        record: makeRecord({ query: "x".repeat(cloudSyncLimits.maxProjectBytes) }),
      }),
      environment,
      { cloudSync: services },
    );

    expect(response.status).toBe(413);
    expect((await readError(response)).code).toBe("cloud_project_too_large");
    expect(memory.getPuts()).toBe(0);
  });
});

describe("cloud sync limits", () => {
  it("should refuse a 101st project but keep saving the ones already synced", async () => {
    const database = new SqliteD1();
    const session = seedTestSession(database);
    seedEntries(database, session.userId, cloudSyncLimits.maxProjects, 1_000);
    const { environment } = makeEnvironment(database);
    const { services } = makeServices();

    const response = await fetchWorker(
      makeSaveRequest(session, { baseRevision: 0, record: makeRecord() }),
      environment,
      { cloudSync: services },
    );

    expect(response.status).toBe(403);
    expect((await readError(response)).code).toBe("cloud_project_limit");
  });

  it("should refuse a save that takes the account past 25 MB", async () => {
    const database = new SqliteD1();
    const session = seedTestSession(database);
    seedEntries(database, session.userId, 25, 1024 * 1024);
    const { environment } = makeEnvironment(database);
    const { services } = makeServices();

    const response = await fetchWorker(
      makeSaveRequest(session, { baseRevision: 0, record: makeRecord() }),
      environment,
      { cloudSync: services },
    );

    expect(response.status).toBe(403);
    expect((await readError(response)).code).toBe("cloud_storage_limit");
  });
});

describe("cloud sync limits under concurrent saves", () => {
  it("should let only one of several new projects take the last project slot", async () => {
    const database = new SqliteD1();
    const session = seedTestSession(database);
    seedEntries(database, session.userId, cloudSyncLimits.maxProjects - 1, 1_000);
    const { environment, memory } = makeEnvironment(database);
    const services = makeLockstepServices(3);

    const responses = await saveNewProjectsAtOnce(session, environment, services, 3);
    const errors = await Promise.all(responses.filter((response) => !response.ok).map(readError));
    const status = await fetchWorker(makeReadRequest(session), environment, { cloudSync: services });

    expect(readSortedStatuses(responses)).toEqual([200, 403, 403]);
    expect(errors.map((error) => error.code)).toEqual(["cloud_project_limit", "cloud_project_limit"]);
    expect(await status.json()).toMatchObject({ usage: { projects: cloudSyncLimits.maxProjects } });
    expect(memory.objects.size).toBe(1);
  });

  it("should let only the saves that fit take the last bytes", async () => {
    const database = new SqliteD1();
    const session = seedTestSession(database);
    const recordBytes = new TextEncoder().encode(JSON.stringify(makeRecord({ id: makeProjectId(0) }))).byteLength;
    seedEntries(database, session.userId, 24, cloudSyncLimits.maxProjectBytes);
    seedEntries(database, session.userId, 1, cloudSyncLimits.maxProjectBytes - Math.ceil(recordBytes * 1.5), 24);
    const { environment, memory } = makeEnvironment(database);
    const services = makeLockstepServices(2);

    const responses = await saveNewProjectsAtOnce(session, environment, services, 2);
    const errors = await Promise.all(responses.filter((response) => !response.ok).map(readError));

    expect(readSortedStatuses(responses)).toEqual([200, 403]);
    expect(errors.map((error) => error.code)).toEqual(["cloud_storage_limit"]);
    expect(memory.objects.size).toBe(1);
  });

  it("should rate limit saves per account, and ask the page to wait a minute", async () => {
    const database = new SqliteD1();
    const session = seedTestSession(database);
    const keys: string[] = [];
    const base = makeEnvironment(database);
    const environment: WorkerEnvironment = {
      ...base.environment,
      CLOUD_SYNC_RATE_LIMIT: {
        limit: async ({ key }) => {
          keys.push(key);
          return { success: false };
        },
      },
    };
    const { services } = makeServices();

    const response = await fetchWorker(
      makeSaveRequest(session, { baseRevision: 0, record: makeRecord() }),
      environment,
      { cloudSync: services },
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await readError(response)).toMatchObject({
      code: "cloud_rate_limited",
      retryAfterMs: saveRateLimitRetryAfterMs,
    });
    expect(keys).toEqual([`user:${session.userId}`]);
    expect(base.memory.getPuts()).toBe(0);
  });
});

/** Services whose index write runs `write` instead, around the real repository. */
function makeFailingIndexServices(write: (insert: () => Promise<boolean>) => Promise<boolean>) {
  const { services } = makeServices();

  return {
    ...services,
    repository: (database) => {
      const repository = createD1CloudRepository(database);

      return {
        ...repository,
        insertProject: (entry, limits) => write(() => repository.insertProject(entry, limits)),
      };
    },
  } satisfies CloudSyncServices;
}

describe("cloud sync objects when the index write fails", () => {
  it("should delete the new object when the index write throws", async () => {
    const database = new SqliteD1();
    const session = seedTestSession(database);
    const { environment, memory } = makeEnvironment(database);
    const services = makeFailingIndexServices(async () => {
      throw new Error("D1 is unavailable");
    });

    const response = await fetchWorker(
      makeSaveRequest(session, { baseRevision: 0, record: makeRecord() }),
      environment,
      { cloudSync: services },
    );

    expect(response.status).toBe(503);
    expect(memory.getPuts()).toBe(1);
    expect(memory.objects.size).toBe(0);
  });

  it("should keep the new object when the index write committed before throwing", async () => {
    const database = new SqliteD1();
    const session = seedTestSession(database);
    const { environment, memory } = makeEnvironment(database);
    const services = makeFailingIndexServices(async (insert) => {
      await insert();
      throw new Error("D1 answered too late");
    });

    const response = await fetchWorker(
      makeSaveRequest(session, { baseRevision: 0, record: makeRecord() }),
      environment,
      { cloudSync: services },
    );
    const read = await fetchWorker(makeReadRequest(session, `/api/cloud/projects/${projectId}`), environment, {
      cloudSync: services,
    });

    expect(response.status).toBe(503);
    expect(read.status).toBe(200);
    expect(memory.objects.size).toBe(1);
  });
});

describe("cloud sync deletes", () => {
  it("should remove only the copy the page last saw, by its revision and content", async () => {
    const database = new SqliteD1();
    const session = seedTestSession(database);
    const { environment, memory } = makeEnvironment(database);
    const { services } = makeServices();
    const record = makeRecord();
    await fetchWorker(makeSaveRequest(session, { baseRevision: 0, record }), environment, { cloudSync: services });
    const digest = digestCloudProject(record);
    const deleteCopy = (copy: { revision: number; digest: string }) =>
      fetchWorker(makeDeleteRequest(session, copy), environment, { cloudSync: services });

    const stale = await deleteCopy({ revision: 2, digest });
    const otherCopy = await deleteCopy({ revision: 1, digest: "0".repeat(64) });
    const removed = await deleteCopy({ revision: 1, digest });
    const again = await deleteCopy({ revision: 1, digest });

    expect(stale.status).toBe(409);
    expect(otherCopy.status).toBe(409);
    expect(removed.status).toBe(204);
    expect(again.status).toBe(204);
    expect(memory.objects.size).toBe(0);
  });
});
