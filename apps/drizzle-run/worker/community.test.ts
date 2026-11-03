import type { PlaygroundSnapshot } from "@drizzle-run/core/contracts";
import { describe, expect, it } from "vitest";

import { seedTestSession, type TestSession } from "../test/worker/sessions";
import { SqliteD1 } from "../test/worker/sqlite-d1";
import { fetchWorker } from "../test/worker/worker-app";
import { type CommunityServices } from "./community";
import { createD1CommunityRepository } from "./community-repository";
import type { CommunityShare } from "./community-share";
import type { WorkerEnvironment } from "./platform";
import { maxShareDescriptionLength, type PlaygroundServices } from "./playgrounds";
import { createD1SessionServices, readSessionUser } from "./session";
import { createD1SnapshotRepository } from "./snapshot-repository";

const origin = "https://run.test";

function makeSnapshotInput(name: string, dialect: "postgresql" | "sqlite" = "sqlite"): PlaygroundSnapshot {
  return {
    snapshotVersion: 1,
    name,
    manifest: {
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect },
      dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
      files: { "schema.ts": "export {};\n", "query.ts": "export {};\n" },
      entrypoints: { schema: "schema.ts", run: "query.ts" },
    },
  };
}

/**
 * A side-by-side share: 0.45 and rc.5 share the seed, and each side writes its own schema and query
 *
 * The rc.5 side runs on `secondDialect`, the 0.45 side's database unless given.
 */
function makePairSnapshotInput(
  name: string,
  dialect: "postgresql" | "sqlite" = "postgresql",
  secondDialect: "postgresql" | "sqlite" = dialect,
): PlaygroundSnapshot {
  return {
    snapshotVersion: 1,
    name,
    manifest: {
      kind: "drizzle-run-pair",
      manifestVersion: 1,
      entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "query.ts" },
      files: { "seed.ts": "export {};\n" },
      sides: [
        {
          target: { dialect },
          dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
          files: { "schema.ts": "export {};\n", "query.ts": "// 0.45\n" },
        },
        {
          target: { dialect: secondDialect },
          dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
          files: { "schema.ts": "export {};\n", "query.ts": "// rc.5\n" },
        },
      ],
    },
  };
}

/** A clock the test moves forward, so listing order is under control. */
function createClock() {
  let minute = 0;
  return {
    now: () => new Date(Date.UTC(2026, 9, 11, 10, minute)).toISOString(),
    tick: () => {
      minute += 1;
    },
  };
}

function createServices(clock = createClock()) {
  let nextId = 0;
  const playgrounds: PlaygroundServices = {
    newId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
    now: clock.now,
    repository: createD1SnapshotRepository,
    listings: createD1CommunityRepository,
    currentUser: (request, environment) => readSessionUser(request, environment, createD1SessionServices()),
  };
  const community: CommunityServices = {
    now: clock.now,
    listings: createD1CommunityRepository,
    snapshots: createD1SnapshotRepository,
    currentUser: (request, environment) => readSessionUser(request, environment, createD1SessionServices()),
  };

  return { playgrounds, community, clock };
}

/** The account the listing requests sign in as, seeded into every test database. */
let signedIn: TestSession;

function makeEnvironment(database: SqliteD1): WorkerEnvironment {
  signedIn = seedTestSession(database);

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

let publishCount = 0;

function makeSameOriginHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { origin, "sec-fetch-site": "same-origin", ...extra };
}

async function publish(
  env: WorkerEnvironment,
  services: PlaygroundServices,
  snapshot: PlaygroundSnapshot,
  session: TestSession = signedIn,
): Promise<string> {
  const response = await fetchWorker(
    new Request(`${origin}/api/playgrounds`, {
      method: "POST",
      headers: makeSameOriginHeaders({
        "content-type": "application/json",
        "idempotency-key": `publish-key-${String(++publishCount).padStart(8, "0")}`,
        cookie: session.cookie,
      }),
      body: JSON.stringify({ snapshot, description: null }),
    }),
    env,
    { playgrounds: services },
  );
  expect(response.status).toBe(200);

  return ((await response.json()) as { id: string }).id;
}

function makeListingRequest(
  id: string,
  body: unknown,
  options: { method?: string; origin?: string; session?: TestSession | null } = {},
): Request {
  const session = options.session === undefined ? signedIn : options.session;
  return new Request(`${origin}/api/playgrounds/${id}/listing`, {
    method: options.method ?? "PUT",
    headers: {
      origin: options.origin ?? origin,
      "sec-fetch-site": options.origin === undefined ? "same-origin" : "cross-site",
      "content-type": "application/json",
      ...(session === null ? {} : { cookie: session.cookie }),
    },
    body: options.method === "DELETE" ? undefined : JSON.stringify(body),
  });
}

async function list(
  env: WorkerEnvironment,
  services: CommunityServices,
  query = "",
): Promise<{ status: number; shares: CommunityShare[]; nextCursor: string | null; body: unknown }> {
  const response = await fetchWorker(new Request(`${origin}/api/community${query}`), env, { community: services });
  const body = (await response.json()) as { shares?: CommunityShare[]; nextCursor?: string | null };

  return { status: response.status, shares: body.shares ?? [], nextCursor: body.nextCursor ?? null, body };
}

function makeReportRequest(id: string, requestOrigin = origin): Request {
  return new Request(`${origin}/api/community/${id}/report`, {
    method: "POST",
    headers: { origin: requestOrigin, "sec-fetch-site": requestOrigin === origin ? "same-origin" : "cross-site" },
  });
}

function readListingRow(database: SqliteD1, id: string): Record<string, unknown> | undefined {
  return database.sqlite.prepare("SELECT * FROM community_listings WHERE link_id = ?").get(id);
}

describe("Community listing routes", () => {
  it.each(["first_listing", "existing_listing"] as const)(
    "should refuse stale metadata after a concurrent push during %s and list the current snapshot on resubmission",
    async (listingState) => {
      const database = new SqliteD1();
      const env = makeEnvironment(database);
      const { playgrounds, community } = createServices();
      const id = await publish(env, playgrounds, makeSnapshotInput("Before"));

      if (listingState === "existing_listing") {
        await fetchWorker(makeListingRequest(id, { topic: "playground" }), env, { community });
      }

      const edited = makePairSnapshotInput("After", "postgresql", "sqlite");
      const racingServices: CommunityServices = {
        ...community,
        listings: (binding) => {
          const repository = createD1CommunityRepository(binding);

          return {
            ...repository,
            async upsertListing(listing) {
              const pushed = await fetchWorker(
                new Request(`${origin}/api/playgrounds/${id}`, {
                  method: "PUT",
                  headers: makeSameOriginHeaders({
                    "content-type": "application/json",
                    cookie: signedIn.cookie,
                  }),
                  body: JSON.stringify({ snapshot: edited }),
                }),
                env,
                { playgrounds },
              );
              expect(pushed.status).toBe(200);

              return repository.upsertListing(listing);
            },
          };
        },
      };

      const response = await fetchWorker(makeListingRequest(id, { topic: "bug-repros" }), env, {
        community: racingServices,
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "snapshot_changed" } });

      const interruptedListing = readListingRow(database, id);
      expect(interruptedListing?.title).toBe(listingState === "existing_listing" ? "After" : undefined);
      expect(interruptedListing?.topic).toBe(listingState === "existing_listing" ? "playground" : undefined);

      const resubmitted = await fetchWorker(makeListingRequest(id, { topic: "bug-repros" }), env, { community });

      expect(resubmitted.status).toBe(200);
      expect(readListingRow(database, id)).toMatchObject({
        title: "After",
        topic: "bug-repros",
        dialect: "postgresql",
        second_dialect: "sqlite",
        second_orm_version: "1.0.0-rc.5",
        file_names: JSON.stringify(["query.ts", "schema.ts", "seed.ts"]),
      });
    },
  );

  it("should list a share with metadata read from the stored snapshot, never from the request", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const { playgrounds, community } = createServices();
    const id = await publish(env, playgrounds, makeSnapshotInput("Soft deletes with deletedAt", "postgresql"));

    const response = await fetchWorker(
      makeListingRequest(id, {
        topic: "playground",
        description: "  Hide deleted   rows by default.  ",
        title: "Ignored",
      }),
      env,
      { community: community },
    );
    const body = (await response.json()) as { listing: CommunityShare };

    expect(response.status).toBe(200);
    expect(body.listing).toEqual({
      id,
      title: "Soft deletes with deletedAt",
      description: "Hide deleted rows by default.",
      topic: "playground",
      releasePair: { dialect: "postgresql", orm: "0.45.4", kit: "0.31.11", guestFlavor: "slim" },
      files: ["query.ts", "schema.ts"],
      listedAt: "2026-10-11T10:00:00.000Z",
      owner: { login: "octocat", avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4" },
    });
    expect((await list(env, community)).shares).toEqual([body.listing]);
  });

  it("should require the same origin, the owner's sign-in, and a link that exists", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const stranger = seedTestSession(database, { login: "stranger", githubId: 42 });
    const { playgrounds, community } = createServices();
    const id = await publish(env, playgrounds, makeSnapshotInput("Owned"));
    const body = { topic: "playground" };

    const crossSite = await fetchWorker(makeListingRequest(id, body, { origin: "https://evil.test" }), env, {
      community: community,
    });
    const missing = await fetchWorker(makeListingRequest(id, body, { session: null }), env, { community: community });
    const wrong = await fetchWorker(makeListingRequest(id, body, { session: stranger }), env, { community: community });
    const unknown = "00000000-0000-4000-8000-00000000ffff";
    const notFound = await fetchWorker(makeListingRequest(unknown, body), env, { community: community });
    const badId = await fetchWorker(makeListingRequest("not-a-uuid", body), env, { community: community });

    expect(crossSite.status).toBe(403);
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe("not_link_owner");
    expect(notFound.status).toBe(404);
    expect(badId.status).toBe(404);
    expect(readListingRow(database, id)).toBeUndefined();
  });

  it("should reject an unknown topic, a long description, and a non-JSON body", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const { playgrounds, community } = createServices();
    const id = await publish(env, playgrounds, makeSnapshotInput("Strict"));

    const topic = await fetchWorker(makeListingRequest(id, { topic: "gossip" }), env, {
      community: community,
    });
    const long = await fetchWorker(
      makeListingRequest(id, {
        topic: "playground",
        description: "x".repeat(maxShareDescriptionLength + 1),
      }),
      env,
      { community: community },
    );
    const text = await fetchWorker(
      new Request(`${origin}/api/playgrounds/${id}/listing`, {
        method: "PUT",
        headers: makeSameOriginHeaders({ cookie: signedIn.cookie, "content-type": "text/plain" }),
        body: "{}",
      }),
      env,
      { community: community },
    );

    expect(topic.status).toBe(422);
    expect(long.status).toBe(422);
    expect(text.status).toBe(415);
    expect(readListingRow(database, id)).toBeUndefined();
  });

  it("should keep the listing time when the topic changes or the owner pushes new code", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const { playgrounds, community, clock } = createServices();
    const id = await publish(env, playgrounds, makeSnapshotInput("Versioned"));

    await fetchWorker(makeListingRequest(id, { topic: "bug-repros" }), env, { community: community });
    clock.tick();
    await fetchWorker(makeListingRequest(id, { topic: "playground", description: "Now about queries" }), env, {
      community: community,
    });

    expect(readListingRow(database, id)).toMatchObject({
      topic: "playground",
      description: "Now about queries",
      listed_at: "2026-10-11T10:00:00.000Z",
    });

    const edited = makeSnapshotInput("Versioned, renamed");
    edited.manifest.files["seed.ts"] = "export {};\n";
    clock.tick();
    const pushed = await fetchWorker(
      new Request(`${origin}/api/playgrounds/${id}`, {
        method: "PUT",
        headers: makeSameOriginHeaders({
          "content-type": "application/json",
          cookie: signedIn.cookie,
        }),
        body: JSON.stringify({ snapshot: edited, description: null }),
      }),
      env,
      { playgrounds: playgrounds },
    );
    expect(pushed.status).toBe(200);

    expect(readListingRow(database, id)).toMatchObject({
      title: "Versioned, renamed",
      description: "Now about queries",
      listed_at: "2026-10-11T10:00:00.000Z",
      file_names: JSON.stringify(["query.ts", "schema.ts", "seed.ts"]),
    });
  });

  it("should unlist for the owner only, and list again on request", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const stranger = seedTestSession(database, { login: "stranger", githubId: 42 });
    const { playgrounds, community, clock } = createServices();
    const id = await publish(env, playgrounds, makeSnapshotInput("Comes and goes"));
    await fetchWorker(makeListingRequest(id, { topic: "playground" }), env, { community: community });

    const rejected = await fetchWorker(
      makeListingRequest(id, undefined, { method: "DELETE", session: stranger }),
      env,
      { community: community },
    );
    expect(rejected.status).toBe(403);
    expect((await list(env, community)).shares).toHaveLength(1);

    const unlisted = await fetchWorker(makeListingRequest(id, undefined, { method: "DELETE" }), env, {
      community: community,
    });
    expect(unlisted.status).toBe(204);
    expect((await list(env, community)).shares).toEqual([]);

    const other = await publish(env, playgrounds, makeSnapshotInput("Never listed"));
    expect(
      (await fetchWorker(makeListingRequest(other, undefined, { method: "DELETE" }), env, { community: community }))
        .status,
    ).toBe(204);

    clock.tick();
    await fetchWorker(makeListingRequest(id, { topic: "playground" }), env, { community: community });
    expect((await list(env, community)).shares.map((share) => share.listedAt)).toEqual(["2026-10-11T10:01:00.000Z"]);
  });

  it("should show who listed a link on the shared link, and nothing once it is unlisted", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const { playgrounds, community } = createServices();
    const id = await publish(env, playgrounds, makeSnapshotInput("Listed author"));
    const readShared = async () => {
      const response = await fetchWorker(new Request(`${origin}/api/playgrounds/${id}`), env, { playgrounds });
      const body = (await response.json()) as { community: CommunityShare | null };

      return { etag: response.headers.get("etag"), community: body.community };
    };

    const unlisted = await readShared();
    expect(unlisted.community).toBeNull();

    await fetchWorker(makeListingRequest(id, { topic: "playground" }), env, { community });
    const listed = await readShared();
    expect(listed.community).toEqual((await list(env, community)).shares[0]);
    expect(listed.community?.owner.login).toBe("octocat");
    expect(listed.etag).not.toBe(unlisted.etag);

    await fetchWorker(makeListingRequest(id, undefined, { method: "DELETE" }), env, { community });
    expect(await readShared()).toEqual(unlisted);
  });

  it("should count reports on listed shares only, without exposing them", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const { playgrounds, community, clock } = createServices();
    const id = await publish(env, playgrounds, makeSnapshotInput("Reported"));
    const unlisted = await publish(env, playgrounds, makeSnapshotInput("Not listed"));
    await fetchWorker(makeListingRequest(id, { topic: "bug-repros" }), env, { community: community });

    clock.tick();
    expect((await fetchWorker(makeReportRequest(id), env, { community: community })).status).toBe(202);
    clock.tick();
    expect((await fetchWorker(makeReportRequest(id), env, { community: community })).status).toBe(202);
    expect((await fetchWorker(makeReportRequest(unlisted), env, { community: community })).status).toBe(404);
    expect((await fetchWorker(makeReportRequest(id, "https://evil.test"), env, { community: community })).status).toBe(
      403,
    );
    expect((await fetchWorker(makeReportRequest("nope"), env, { community: community })).status).toBe(404);

    expect(readListingRow(database, id)).toMatchObject({
      report_count: 2,
      last_reported_at: "2026-10-11T10:02:00.000Z",
    });
    const { shares, body } = await list(env, community, "?topic=bug-repros");
    expect(shares.map((share) => share.id)).toEqual([id]);
    expect(JSON.stringify(body)).not.toContain("report");
  });

  it("should rate limit reports under their own key", async () => {
    const database = new SqliteD1();
    const keys: string[] = [];
    const env: WorkerEnvironment = {
      ...makeEnvironment(database),
      PUBLISH_RATE_LIMIT: {
        async limit({ key }) {
          keys.push(key);
          return { success: !key.startsWith("report:") };
        },
      },
    };
    const { playgrounds, community } = createServices();
    const id = await publish(env, playgrounds, makeSnapshotInput("Limited"));
    await fetchWorker(makeListingRequest(id, { topic: "playground" }), env, { community: community });

    const request = makeReportRequest(id);
    request.headers.set("cf-connecting-ip", "203.0.113.7");
    const limited = await fetchWorker(request, env, { community: community });

    expect(limited.status).toBe(429);
    expect(keys.at(-1)).toBe("report:ip:203.0.113.7");
    expect(readListingRow(database, id)).toMatchObject({ report_count: 0 });
  });

  it("should keep a share removed by hand out of the list, so its owner cannot list it again", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const { playgrounds, community } = createServices();
    const id = await publish(env, playgrounds, makeSnapshotInput("Removed"));
    await fetchWorker(makeListingRequest(id, { topic: "playground" }), env, { community: community });

    database.sqlite.prepare("UPDATE community_listings SET state = 'removed' WHERE link_id = ?").run(id);

    expect((await list(env, community)).shares).toEqual([]);
    const relist = await fetchWorker(makeListingRequest(id, { topic: "playground" }), env, {
      community: community,
    });
    expect(relist.status).toBe(403);
    expect(((await relist.json()) as { error: { code: string } }).error.code).toBe("listing_removed");
    expect((await fetchWorker(makeReportRequest(id), env, { community: community })).status).toBe(404);
    expect(
      (await fetchWorker(makeListingRequest(id, undefined, { method: "DELETE" }), env, { community: community }))
        .status,
    ).toBe(204);
    expect(readListingState(database, id)).toBe("removed");
  });
});

function readListingState(database: SqliteD1, id: string): unknown {
  return (
    database.sqlite.prepare("SELECT state FROM community_listings WHERE link_id = ?").get(id) as
      | { state: unknown }
      | undefined
  )?.state;
}

describe("Community sign-in", () => {
  it("should refuse to list without a signed-in account", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const { playgrounds, community } = createServices();
    const id = await publish(env, playgrounds, makeSnapshotInput("Signed out"));

    const response = await fetchWorker(makeListingRequest(id, { topic: "playground" }, { session: null }), env, {
      community: community,
    });

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("sign_in_required");
    expect(readListingRow(database, id)).toBeUndefined();
  });

  it("should refuse a listing by another account", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const stranger = seedTestSession(database, { login: "stranger", githubId: 42 });
    const { playgrounds, community } = createServices();
    const id = await publish(env, playgrounds, makeSnapshotInput("Mine"));
    await fetchWorker(makeListingRequest(id, { topic: "playground" }), env, { community: community });

    const response = await fetchWorker(makeListingRequest(id, { topic: "playground" }, { session: stranger }), env, {
      community: community,
    });

    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not_link_owner");
    expect(readListingRow(database, id)).toMatchObject({ owner_user_id: signedIn.userId, topic: "playground" });
  });

  it("should show the lister's current login on the card", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const { playgrounds, community } = createServices();
    const id = await publish(env, playgrounds, makeSnapshotInput("Renamed"));
    await fetchWorker(makeListingRequest(id, { topic: "playground" }), env, { community: community });

    database.sqlite.prepare("UPDATE users SET login = ? WHERE id = ?").run("octo-renamed", signedIn.userId);

    expect((await list(env, community)).shares.map((share) => share.owner)).toEqual([
      { login: "octo-renamed", avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4" },
    ]);
  });
});

async function seedCommunity() {
  const database = new SqliteD1();
  const env = makeEnvironment(database);
  const { playgrounds, community, clock } = createServices();
  const items = [
    {
      name: "Soft deletes with deletedAt",
      dialect: "postgresql",
      topic: "playground",
      description: "Hide deleted rows by default.",
    },
    {
      name: "Cursor pagination on posts",
      dialect: "postgresql",
      topic: "playground",
      description: "Page through posts without offsets.",
    },
    { name: "Upsert with onConflictDoUpdate", dialect: "sqlite", topic: "playground", description: null },
    { name: "100% coverage of a schema", dialect: "sqlite", topic: "playground", description: "Every column type." },
    { name: "Repro: composite key", dialect: "postgresql", topic: "bug-repros", description: "A minimal case." },
  ] as const;
  const ids: string[] = [];

  for (const item of items) {
    const id = await publish(env, playgrounds, makeSnapshotInput(item.name, item.dialect));
    await fetchWorker(makeListingRequest(id, { topic: item.topic, description: item.description }), env, {
      community: community,
    });
    ids.push(id);
    clock.tick();
  }

  return { env, community, ids };
}

describe("Community list route", () => {
  it("should return playgrounds newest first by default, and the oldest first on request", async () => {
    const { env, community, ids } = await seedCommunity();
    const playgroundIds = ids.slice(0, 4);

    expect((await list(env, community)).shares.map((share) => share.id)).toEqual(playgroundIds.toReversed());
    expect((await list(env, community, "?sort=oldest")).shares.map((share) => share.id)).toEqual(playgroundIds);
  });

  it("should filter by search, topic, and database together", async () => {
    const { env, community, ids } = await seedCommunity();
    const titles = async (query: string) => (await list(env, community, query)).shares.map((share) => share.title);

    expect(await titles("?q=POSTS")).toEqual(["Cursor pagination on posts"]);
    expect(await titles("?q=deleted%20rows")).toEqual(["Soft deletes with deletedAt"]);
    expect(await titles("?q=100%25")).toEqual(["100% coverage of a schema"]);
    expect(await titles("?q=_")).toEqual([]);
    expect(await titles("?db=sqlite")).toEqual(["100% coverage of a schema", "Upsert with onConflictDoUpdate"]);
    expect(await titles("?topic=bug-repros")).toEqual(["Repro: composite key"]);
    expect(await titles("?q=composite")).toEqual([]);
    expect(await titles("?db=postgresql&sort=oldest")).toEqual([
      "Soft deletes with deletedAt",
      "Cursor pagination on posts",
    ]);
    expect(await titles("?topic=playground&db=postgresql&sort=oldest")).toEqual([
      "Soft deletes with deletedAt",
      "Cursor pagination on posts",
    ]);
    expect(ids).toHaveLength(5);
  });

  it("should page with a cursor until the last page", async () => {
    const { env, community, ids } = await seedCommunity();
    const first = await list(env, community, "?limit=3");
    const second = await list(env, community, `?limit=3&cursor=${first.nextCursor ?? ""}`);

    expect(first.shares.map((share) => share.id)).toEqual([ids[3], ids[2], ids[1]]);
    expect(second.shares.map((share) => share.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();

    const oldest = await list(env, community, "?limit=3&sort=oldest");
    const rest = await list(env, community, `?limit=3&sort=oldest&cursor=${oldest.nextCursor ?? ""}`);
    expect([...oldest.shares, ...rest.shares].map((share) => share.id)).toEqual(ids.slice(0, 4));
    expect(rest.nextCursor).toBeNull();
  });

  it("should reject malformed queries", async () => {
    const { env, community } = await seedCommunity();

    for (const query of [
      "?topic=gossip",
      "?db=mysql",
      "?sort=popular",
      "?limit=0",
      "?limit=49",
      "?limit=two",
      "?cursor=nope",
      `?q=${"x".repeat(101)}`,
    ]) {
      expect((await list(env, community, query)).status, query).toBe(400);
    }
  });

  it("should list a side-by-side share with both pairs and every file either side runs", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const { playgrounds, community } = createServices();
    const id = await publish(env, playgrounds, makePairSnapshotInput("Filters: 0.45 vs rc.5"));

    const response = await fetchWorker(makeListingRequest(id, { topic: "playground" }), env, {
      community: community,
    });
    const body = (await response.json()) as { listing: CommunityShare };

    expect(response.status).toBe(200);
    expect(body.listing).toEqual({
      id,
      title: "Filters: 0.45 vs rc.5",
      description: null,
      topic: "playground",
      releasePair: { dialect: "postgresql", orm: "0.45.4", kit: "0.31.11", guestFlavor: "slim" },
      sides: [
        { dialect: "postgresql", orm: "0.45.4", kit: "0.31.11", guestFlavor: "slim" },
        { dialect: "postgresql", orm: "1.0.0-rc.5", kit: "1.0.0-rc.5", guestFlavor: "slim" },
      ],
      files: ["query.ts", "schema.ts", "seed.ts"],
      listedAt: "2026-10-11T10:00:00.000Z",
      owner: { login: "octocat", avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4" },
    });
    expect(readListingRow(database, id)).toMatchObject({
      second_dialect: "postgresql",
      second_orm_version: "1.0.0-rc.5",
      second_kit_version: "1.0.0-rc.5",
    });
    expect((await list(env, community)).shares).toEqual([body.listing]);
  });

  it("should list a side's effect flavor from its guestFlavor", async () => {
    const env = makeEnvironment(new SqliteD1());
    const { playgrounds, community } = createServices();
    const snapshot = makePairSnapshotInput("Plain vs Effect");

    if (snapshot.manifest.kind !== "drizzle-run-pair") {
      throw new Error("Expected a side-by-side snapshot.");
    }

    const [, nextSide] = snapshot.manifest.sides;
    const effectSnapshot = {
      ...snapshot,
      manifest: {
        ...snapshot.manifest,
        sides: [
          { ...nextSide, files: { ...nextSide.files, "query.ts": "// plain\n" } },
          { ...nextSide, guestFlavor: "effect" },
        ],
      },
    } satisfies PlaygroundSnapshot;
    const id = await publish(env, playgrounds, effectSnapshot);

    const response = await fetchWorker(makeListingRequest(id, { topic: "playground" }), env, {
      community: community,
    });
    const body = (await response.json()) as { listing: CommunityShare };

    expect(response.status).toBe(200);
    expect(body.listing.sides).toEqual([
      { dialect: "postgresql", orm: "1.0.0-rc.5", kit: "1.0.0-rc.5", guestFlavor: "slim" },
      { dialect: "postgresql", orm: "1.0.0-rc.5", kit: "1.0.0-rc.5", guestFlavor: "effect" },
    ]);
  });

  it("should list a side's name, on two sides of one release, and store it in D1", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const { playgrounds, community } = createServices();
    const snapshot = makePairSnapshotInput("Select vs relational queries");

    if (snapshot.manifest.kind !== "drizzle-run-pair") {
      throw new Error("Expected a side-by-side snapshot.");
    }

    const [, nextSide] = snapshot.manifest.sides;
    const namedSnapshot = {
      ...snapshot,
      manifest: {
        ...snapshot.manifest,
        sides: [
          { ...nextSide, name: "Classic", files: { ...nextSide.files, "query.ts": "// select\n" } },
          { ...nextSide, files: { ...nextSide.files, "query.ts": "// db.query\n" } },
        ],
      },
    } satisfies PlaygroundSnapshot;
    const id = await publish(env, playgrounds, namedSnapshot);

    const response = await fetchWorker(makeListingRequest(id, { topic: "playground" }), env, {
      community: community,
    });
    const body = (await response.json()) as { listing: CommunityShare };

    expect(response.status).toBe(200);
    expect(body.listing.sides).toEqual([
      { dialect: "postgresql", orm: "1.0.0-rc.5", kit: "1.0.0-rc.5", guestFlavor: "slim", name: "Classic" },
      { dialect: "postgresql", orm: "1.0.0-rc.5", kit: "1.0.0-rc.5", guestFlavor: "slim" },
    ]);
    expect(readListingRow(database, id)).toMatchObject({ side_name: "Classic", second_side_name: null });
    expect((await list(env, community)).shares).toEqual([body.listing]);
  });

  it("should list side-by-side and one-version shares together under the same filters", async () => {
    const env = makeEnvironment(new SqliteD1());
    const { playgrounds, community, clock } = createServices();
    const shares = [
      { snapshot: makePairSnapshotInput("Filters: 0.45 vs rc.5"), topic: "playground" },
      { snapshot: makeSnapshotInput("Soft deletes", "postgresql"), topic: "playground" },
      { snapshot: makePairSnapshotInput("Repro: count changed", "sqlite"), topic: "bug-repros" },
    ];

    for (const { snapshot, topic } of shares) {
      const id = await publish(env, playgrounds, snapshot);

      expect((await fetchWorker(makeListingRequest(id, { topic }), env, { community: community })).status).toBe(200);
      clock.tick();
    }

    const listed = async (query: string) =>
      (await list(env, community, query)).shares.map((share) => [share.title, share.sides !== undefined]);

    expect(await listed("")).toEqual([
      ["Soft deletes", false],
      ["Filters: 0.45 vs rc.5", true],
    ]);
    expect(await listed("?db=postgresql")).toEqual([
      ["Soft deletes", false],
      ["Filters: 0.45 vs rc.5", true],
    ]);
    expect(await listed("?topic=bug-repros&db=sqlite")).toEqual([["Repro: count changed", true]]);
    expect(await listed("?q=filters&sort=oldest")).toEqual([["Filters: 0.45 vs rc.5", true]]);
  });

  it("should list sides on two databases under either database's filter, each side with its own", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const { playgrounds, community, clock } = createServices();
    const shares = [
      makePairSnapshotInput("PostgreSQL vs SQLite", "postgresql", "sqlite"),
      makeSnapshotInput("Only SQLite", "sqlite"),
      makeSnapshotInput("Only PostgreSQL", "postgresql"),
    ];
    const ids: string[] = [];

    for (const snapshot of shares) {
      const id = await publish(env, playgrounds, snapshot);

      await fetchWorker(makeListingRequest(id, { topic: "playground" }), env, { community: community });
      ids.push(id);
      clock.tick();
    }

    const titles = async (query: string) => (await list(env, community, query)).shares.map((share) => share.title);
    const [crossDatabase] = (await list(env, community, "?sort=oldest")).shares;

    expect(await titles("?db=sqlite&sort=oldest")).toEqual(["PostgreSQL vs SQLite", "Only SQLite"]);
    expect(await titles("?db=postgresql&sort=oldest")).toEqual(["PostgreSQL vs SQLite", "Only PostgreSQL"]);
    expect(crossDatabase?.releasePair.dialect).toBe("postgresql");
    expect(crossDatabase?.sides?.map((side) => side.dialect)).toEqual(["postgresql", "sqlite"]);
    expect(readListingRow(database, ids[0] ?? "")).toMatchObject({ dialect: "postgresql", second_dialect: "sqlite" });
    expect(readListingRow(database, ids[1] ?? "")).toMatchObject({ dialect: "sqlite", second_dialect: null });
  });

  it("should return an empty first page when nothing is listed", async () => {
    const env = makeEnvironment(new SqliteD1());
    const { community } = createServices();

    expect(await list(env, community)).toMatchObject({ status: 200, shares: [], nextCursor: null });
  });
});
