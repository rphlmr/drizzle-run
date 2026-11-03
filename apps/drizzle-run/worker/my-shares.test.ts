import type { PlaygroundSnapshot } from "@drizzle-run/core/contracts";
import { describe, expect, it } from "vitest";

import { seedTestSession, type TestSession } from "../test/worker/sessions";
import { SqliteD1 } from "../test/worker/sqlite-d1";
import { fetchWorker } from "../test/worker/worker-app";
import { type CommunityServices } from "./community";
import { createD1CommunityRepository } from "./community-repository";
import { type MyShare, type MySharesServices } from "./my-shares";
import { createD1MySharesRepository } from "./my-shares-repository";
import type { WorkerEnvironment } from "./platform";
import { type PlaygroundServices } from "./playgrounds";
import { createD1SessionServices, readSessionUser } from "./session";
import { createD1SnapshotRepository } from "./snapshot-repository";

const origin = "https://run.test";

function makeSnapshotInput(name: string): PlaygroundSnapshot {
  return {
    snapshotVersion: 1,
    name,
    manifest: {
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect: "sqlite" },
      dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
      files: { "schema.ts": "export {};\n", "query.ts": "export {};\n" },
      entrypoints: { schema: "schema.ts", run: "query.ts" },
    },
  };
}

/** The one pair \`makeSnapshotInput\` runs, as My shares lists it. */
const legacySqlitePair = { dialect: "sqlite", orm: "0.45.4", kit: "0.31.11", guestFlavor: "slim" };

/** A clock the test moves forward; links published without a tick share a creation time. */
function createClock() {
  let minute = 0;

  return {
    now: () => new Date(Date.UTC(2026, 9, 11, 10, minute)).toISOString(),
    tick: () => {
      minute += 1;
    },
  };
}

function currentUser(request: Request, environment: WorkerEnvironment) {
  return readSessionUser(request, environment, createD1SessionServices());
}

function createServices() {
  const clock = createClock();
  let nextId = 0;
  const playgrounds: PlaygroundServices = {
    newId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
    now: clock.now,
    repository: createD1SnapshotRepository,
    listings: createD1CommunityRepository,
    currentUser,
  };
  const community: CommunityServices = {
    now: clock.now,
    listings: createD1CommunityRepository,
    snapshots: createD1SnapshotRepository,
    currentUser,
  };
  const myShares: MySharesServices = { shares: createD1MySharesRepository, currentUser };

  return { playgrounds, community, myShares, clock };
}

function makeEnvironment(database: SqliteD1): WorkerEnvironment {
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

function makeSameOriginHeaders(session: TestSession | null, extra: Record<string, string> = {}) {
  return {
    origin,
    "sec-fetch-site": "same-origin",
    ...(session === null ? {} : { cookie: session.cookie }),
    ...extra,
  };
}

let publishCount = 0;

async function publish(
  env: WorkerEnvironment,
  services: PlaygroundServices,
  { name, session }: { name: string; session: TestSession },
): Promise<string> {
  const response = await fetchWorker(
    new Request(`${origin}/api/playgrounds`, {
      method: "POST",
      headers: makeSameOriginHeaders(session, {
        "content-type": "application/json",
        "idempotency-key": `publish-key-${String(++publishCount).padStart(8, "0")}`,
      }),
      body: JSON.stringify({ snapshot: makeSnapshotInput(name), description: null }),
    }),
    env,
    { playgrounds: services },
  );
  expect(response.status).toBe(200);

  return ((await response.json()) as { id: string }).id;
}

async function list(
  env: WorkerEnvironment,
  services: MySharesServices,
  { session, query = "" }: { session: TestSession | null; query?: string },
): Promise<{ status: number; shares: MyShare[]; nextCursor: string | null; code: string | undefined }> {
  const response = await fetchWorker(
    new Request(`${origin}/api/me/shares${query}`, { headers: session === null ? {} : { cookie: session.cookie } }),
    env,
    { myShares: services },
  );
  const body = (await response.json()) as {
    shares?: MyShare[];
    nextCursor?: string | null;
    error?: { code: string };
  };

  return {
    status: response.status,
    shares: body.shares ?? [],
    nextCursor: body.nextCursor ?? null,
    code: body.error?.code,
  };
}

function makeListingRequest(id: string, session: TestSession, method: "PUT" | "DELETE" = "PUT"): Request {
  return new Request(`${origin}/api/playgrounds/${id}/listing`, {
    method,
    headers: makeSameOriginHeaders(session, { "content-type": "application/json" }),
    body: method === "DELETE" ? undefined : JSON.stringify({ topic: "bug-repros", description: null }),
  });
}

describe("listMyShares", () => {
  it("should list the caller's links by last change, with their Community state", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const octocat = seedTestSession(database);
    const { playgrounds, community, myShares, clock } = createServices();
    const neverListed = await publish(env, playgrounds, { name: "Never listed", session: octocat });
    clock.tick();
    const listed = await publish(env, playgrounds, { name: "Listed", session: octocat });
    clock.tick();
    const unlisted = await publish(env, playgrounds, { name: "Unlisted", session: octocat });
    clock.tick();
    const removed = await publish(env, playgrounds, { name: "Removed", session: octocat });

    for (const id of [listed, unlisted, removed]) {
      expect((await fetchWorker(makeListingRequest(id, octocat), env, { community: community })).status).toBe(200);
    }

    await fetchWorker(makeListingRequest(unlisted, octocat, "DELETE"), env, { community: community });
    database.sqlite.prepare("UPDATE community_listings SET state = 'removed' WHERE link_id = ?").run(removed);
    clock.tick();
    const pushed = await fetchWorker(
      new Request(`${origin}/api/playgrounds/${neverListed}`, {
        method: "PUT",
        headers: makeSameOriginHeaders(octocat, { "content-type": "application/json" }),
        body: JSON.stringify({ snapshot: makeSnapshotInput("Never listed, renamed"), description: null }),
      }),
      env,
      { playgrounds: playgrounds },
    );
    expect(pushed.status).toBe(200);

    const result = await list(env, myShares, { session: octocat });

    expect(result.status).toBe(200);
    expect(result.nextCursor).toBeNull();
    expect(result.shares).toEqual([
      {
        id: removed,
        title: "Removed",
        description: null,
        pairs: [legacySqlitePair],
        createdAt: "2026-10-11T10:03:00.000Z",
        updatedAt: "2026-10-11T10:03:00.000Z",
        listing: { state: "removed", topic: "bug-repros" },
      },
      {
        id: unlisted,
        title: "Unlisted",
        description: null,
        pairs: [legacySqlitePair],
        createdAt: "2026-10-11T10:02:00.000Z",
        updatedAt: "2026-10-11T10:02:00.000Z",
        listing: { state: "unlisted", topic: "bug-repros" },
      },
      {
        id: listed,
        title: "Listed",
        description: null,
        pairs: [legacySqlitePair],
        createdAt: "2026-10-11T10:01:00.000Z",
        updatedAt: "2026-10-11T10:01:00.000Z",
        listing: { state: "listed", topic: "bug-repros" },
      },
      {
        id: neverListed,
        title: "Never listed, renamed",
        description: null,
        pairs: [legacySqlitePair],
        createdAt: "2026-10-11T10:00:00.000Z",
        updatedAt: "2026-10-11T10:04:00.000Z",
        listing: null,
      },
    ]);
  });

  it("should never show another account's links", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const octocat = seedTestSession(database);
    const hubot = seedTestSession(database, { login: "hubot", githubId: 480938 });
    const { playgrounds, community, myShares } = createServices();
    const mine = await publish(env, playgrounds, { name: "Mine", session: octocat });
    const theirs = await publish(env, playgrounds, { name: "Theirs", session: hubot });
    expect((await fetchWorker(makeListingRequest(theirs, hubot), env, { community: community })).status).toBe(200);

    const octocatShares = await list(env, myShares, { session: octocat });
    const hubotShares = await list(env, myShares, { session: hubot });

    expect(octocatShares.shares.map((share) => share.id)).toEqual([mine]);
    expect(hubotShares.shares.map((share) => share.id)).toEqual([theirs]);
    expect(hubotShares.shares[0]?.listing?.state).toBe("listed");
  });

  it("should page through every link once, in order, including links created at the same time", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const octocat = seedTestSession(database);
    const hubot = seedTestSession(database, { login: "hubot", githubId: 480938 });
    const { playgrounds, myShares, clock } = createServices();
    const published: string[] = [];

    for (const index of [1, 2, 3, 4, 5]) {
      if (index % 2 === 0) {
        clock.tick();
      }

      published.push(await publish(env, playgrounds, { name: `Share ${index}`, session: octocat }));
      await publish(env, playgrounds, { name: `Other ${index}`, session: hubot });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const query: string = `?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`;
      const page = await list(env, myShares, { session: octocat, query });
      expect(page.status).toBe(200);
      seen.push(...page.shares.map((share) => share.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);

    expect(pages).toBe(3);
    expect(seen).toEqual(published.toReversed());
  });

  it("should keep only the caller's links whose name contains the search, ignoring case, page by page", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const octocat = seedTestSession(database);
    const hubot = seedTestSession(database, { login: "hubot", githubId: 480938 });
    const { playgrounds, myShares, clock } = createServices();
    const softDeletes = await publish(env, playgrounds, { name: "Soft deletes", session: octocat });
    clock.tick();
    await publish(env, playgrounds, { name: "Joins", session: octocat });
    clock.tick();
    const softLimits = await publish(env, playgrounds, { name: "Rate limits, soft", session: octocat });
    await publish(env, playgrounds, { name: "Soft deletes too", session: hubot });

    const first = await list(env, myShares, { session: octocat, query: "?limit=1&q=SOFT" });
    const second = await list(env, myShares, { session: octocat, query: `?limit=1&q=SOFT&cursor=${first.nextCursor}` });
    const blank = await list(env, myShares, { session: octocat, query: "?q=%20%20" });

    expect(first.shares.map((share) => share.id)).toEqual([softLimits]);
    expect(second.shares.map((share) => share.id)).toEqual([softDeletes]);
    expect(second.nextCursor).toBeNull();
    expect(blank.shares).toHaveLength(3);
  });

  it("should refuse a signed-out request, a bad cursor and an out-of-range page size", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const octocat = seedTestSession(database);
    const { myShares } = createServices();

    const signedOut = await list(env, myShares, { session: null });
    const badCursor = await list(env, myShares, { session: octocat, query: "?cursor=not-a-cursor" });
    const tooLarge = await list(env, myShares, { session: octocat, query: "?limit=49" });
    const longSearch = await list(env, myShares, { session: octocat, query: `?q=${"a".repeat(161)}` });

    expect(signedOut).toMatchObject({ status: 401, code: "sign_in_required" });
    expect(badCursor).toMatchObject({ status: 400, code: "invalid_query" });
    expect(tooLarge).toMatchObject({ status: 400, code: "invalid_query" });
    expect(longSearch).toMatchObject({ status: 400, code: "invalid_query" });
  });

  it("should read an owner's page from the owner index without sorting", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const octocat = seedTestSession(database);
    const { myShares } = createServices();
    const queries: string[] = [];
    const prepare = database.prepare.bind(database);
    database.prepare = (query) => {
      queries.push(query);
      return prepare(query);
    };
    const cursor = btoa(JSON.stringify(["2026-10-11T10:00:00.000Z", "00000000-0000-4000-8000-000000000001"]));

    await list(env, myShares, { session: octocat, query: `?cursor=${cursor}` });
    const shareQuery = queries.find((query) => query.includes('from "playground_links"'));
    const plan = database.sqlite
      .prepare(`EXPLAIN QUERY PLAN ${shareQuery ?? ""}`)
      .all()
      .map((row) => String(row.detail));

    expect(plan.join("\n")).toContain("playground_links_owner_created");
    expect(plan.join("\n")).not.toContain("TEMP B-TREE");
  });
});
