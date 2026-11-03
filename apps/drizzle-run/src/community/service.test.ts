import { describe, expect, it, vi } from "vitest";

import type { CommunityQuery } from "./contract";
import { createCommunityService } from "./service";
import { formatShareDialects, getEffectSuffix, getSharePairLabel, getSharePairTitle } from "./share-labels";

const origin = "https://run.example.test";
const id = "123e4567-e89b-42d3-a456-426614174000";
const signal = new AbortController().signal;
const everyShare: CommunityQuery = { search: "", topic: "playground", dialect: undefined, sort: "newest" };

function makeJsonResponse(body: unknown, status = 200) {
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

/** A Community service whose every request `fetchMock` answers. */
function makeService(fetchMock: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetch = vi.fn(fetchMock);

  return { fetch, community: createCommunityService({ fetch, origin }) };
}

const share = {
  id,
  title: "Soft deletes",
  description: null,
  topic: "playground",
  releasePair: { dialect: "postgresql", orm: "0.45.4", kit: "0.31.11", guestFlavor: "slim" },
  files: ["query.ts", "schema.ts"],
  listedAt: "2026-10-09T00:00:00.000Z",
  owner: { login: "octocat", avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4" },
};

describe("createCommunityService", () => {
  it("should always send the topic, and only the other filters that are set", async () => {
    const { fetch, community } = makeService(async () => makeJsonResponse({ shares: [share], nextCursor: "next" }));

    const page = await community.fetchCommunityPage({
      query: { search: "  soft ", topic: "bug-repros", dialect: "postgresql", sort: "oldest" },
      cursor: "abc",
      signal,
    });
    await community.fetchCommunityPage({ query: everyShare, cursor: undefined, signal });

    expect(fetch.mock.calls[0]?.[0]).toBe(
      `${origin}/api/community?q=soft&topic=bug-repros&db=postgresql&sort=oldest&cursor=abc`,
    );
    expect(fetch.mock.calls[1]?.[0]).toBe(`${origin}/api/community?topic=playground`);
    expect(page).toEqual({ shares: [share], nextCursor: "next" });
  });

  it("should pass the caller's abort signal to every request", async () => {
    const { fetch, community } = makeService(async () => new Response(null, { status: 204 }));
    const controller = new AbortController();

    await community.unlistShareFromCommunity({ linkId: id, signal: controller.signal });
    await community.reportCommunityShare({ shareId: id, signal: controller.signal });

    for (const [, init] of fetch.mock.calls) {
      expect(init?.signal).toBe(controller.signal);
    }
  });

  it("should refuse a malformed share instead of rendering it", async () => {
    const { community } = makeService(async () =>
      makeJsonResponse({ shares: [{ ...share, topic: "gossip" }], nextCursor: null }),
    );

    await expect(community.fetchCommunityPage({ query: everyShare, cursor: undefined, signal })).rejects.toThrow(
      "invalid Community share",
    );
  });

  it("should refuse a page that is not a page", async () => {
    const { community } = makeService(async () => makeJsonResponse({ shares: [], nextCursor: 42 }));

    await expect(community.fetchCommunityPage({ query: everyShare, cursor: undefined, signal })).rejects.toThrow(
      "invalid Community page",
    );
  });

  it("should refuse an owner whose avatar is not on GitHub's avatar host, or whose login is not a GitHub login", async () => {
    const owners = [
      { login: "octocat", avatarUrl: "https://evil.test/u/583231?v=4" },
      { login: "octocat", avatarUrl: "javascript:alert(1)" },
      { login: "<img src=x>", avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4" },
    ];

    for (const owner of owners) {
      const { community } = makeService(async () =>
        makeJsonResponse({ shares: [{ ...share, owner }], nextCursor: null }),
      );

      await expect(community.fetchCommunityPage({ query: everyShare, cursor: undefined, signal })).rejects.toThrow(
        "invalid Community share",
      );
    }
  });

  it("should read a side-by-side share with both pairs, and name both and Effect in its title", async () => {
    const sides = [
      { dialect: "postgresql", orm: "0.45.4", kit: "0.31.11", guestFlavor: "slim" },
      { dialect: "sqlite", orm: "1.0.0-rc.5", kit: "1.0.0-rc.5", guestFlavor: "effect" },
    ];
    const { community } = makeService(async () =>
      makeJsonResponse({ shares: [share, { ...share, title: "Filters", sides }], nextCursor: null }),
    );

    const { shares } = await community.fetchCommunityPage({ query: everyShare, cursor: undefined, signal });

    const [plain, pair] = shares;

    expect(plain).not.toHaveProperty("sides");
    expect(pair?.sides).toEqual(sides);
    expect(plain && getSharePairTitle(plain)).toBe("ORM 0.45.4 with Kit 0.31.11");
    expect(pair && getSharePairTitle(pair)).toBe(
      "ORM 0.45.4 with Kit 0.31.11, and ORM 1.0.0-rc.5 with Kit 1.0.0-rc.5 and Effect 4",
    );
    expect(pair?.sides?.map(getEffectSuffix)).toEqual(["", " + Effect"]);
    expect(plain && formatShareDialects(plain)).toBe("PostgreSQL");
    expect(pair && formatShareDialects(pair)).toBe("PostgreSQL vs SQLite");
    expect(plain && getSharePairLabel({ ...plain, releasePair: { ...plain.releasePair, guestFlavor: "effect" } })).toBe(
      "orm 0.45.4 + Effect",
    );
  });

  it("should refuse a side-by-side share without two pairs", async () => {
    for (const sides of [
      [{ orm: "0.45.4", kit: "0.31.11" }],
      [{ orm: "0.45.4" }, { orm: "1.0.0-rc.5", kit: "1.0.0-rc.5", guestFlavor: "slim" }],
      [
        { dialect: "postgresql", orm: "0.45.4", kit: "0.31.11", guestFlavor: "slim" },
        { orm: "1.0.0-rc.5", kit: "1.0.0-rc.5", guestFlavor: "slim" },
      ],
      null,
    ]) {
      const { community } = makeService(async () =>
        makeJsonResponse({ shares: [{ ...share, sides }], nextCursor: null }),
      );

      await expect(community.fetchCommunityPage({ query: everyShare, cursor: undefined, signal })).rejects.toThrow(
        "invalid Community share",
      );
    }
  });

  it("should say Drizzle Run could not be reached, not the browser's own text, when a request never arrives", async () => {
    const { community } = makeService(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(community.fetchCommunityPage({ query: everyShare, cursor: undefined, signal })).rejects.toThrow(
      "Drizzle Run could not be reached. Check your connection, then try again.",
    );
  });

  it("should turn Worker error codes into plain messages", async () => {
    const responses = [
      makeJsonResponse({ error: { code: "listing_removed" } }, 403),
      makeJsonResponse({ error: { code: "rate_limited" } }, 429),
      new Response("oops", { status: 500 }),
    ];
    const { community } = makeService(async () => responses.shift() ?? new Response(null, { status: 500 }));

    await expect(
      community.listShareInCommunity({
        linkId: id,
        choice: { topic: "playground", description: "" },
        signal,
      }),
    ).rejects.toThrow("removed from Community after reports");
    await expect(community.reportCommunityShare({ shareId: id, signal })).rejects.toThrow("Too many reports");
    await expect(community.reportCommunityShare({ shareId: id, signal })).rejects.toThrow("could not be sent");
  });

  it("should list with an empty description as null, without an Authorization header", async () => {
    const { fetch, community } = makeService(async () => makeJsonResponse({ listing: share }));

    await community.listShareInCommunity({
      linkId: id,
      choice: { topic: "playground", description: "   " },
      signal,
    });

    const init = fetch.mock.calls[0]?.[1];
    expect(init).toMatchObject({ method: "PUT" });
    expect(init?.headers).not.toHaveProperty("Authorization");
    expect(readJsonBody(init)).toEqual({ topic: "playground", description: null });
  });

  it("should explain how to resubmit a listing when another browser pushed new code", async () => {
    const { community } = makeService(async () => makeJsonResponse({ error: { code: "snapshot_changed" } }, 409));

    await expect(
      community.listShareInCommunity({
        linkId: id,
        choice: { topic: "playground", description: "" },
        signal,
      }),
    ).rejects.toThrow("The shared code changed while saving the listing. Try again to list its current code.");
  });
});
