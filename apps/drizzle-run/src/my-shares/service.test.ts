import { describe, expect, it, vi } from "vitest";

import { MySharesError, type MyShare } from "./contract";
import { createMySharesService } from "./service";

const origin = "https://run.example.test";
const signal = new AbortController().signal;

function makeJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeService(fetchMock: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetch = vi.fn(fetchMock);

  return { fetch, myShares: createMySharesService({ fetch, origin }) };
}

const share: MyShare = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  title: "Soft deletes",
  description: null,
  pairs: [{ dialect: "postgresql", orm: "1.0.0-rc.5", kit: "1.0.0-rc.5", guestFlavor: "slim" }],
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
  listing: { state: "listed", topic: "playground" },
};

describe("createMySharesService", () => {
  it("should load the first page without a cursor and pass the next cursor on", async () => {
    const { fetch, myShares } = makeService(async () => makeJsonResponse({ shares: [share], nextCursor: "next" }));

    const first = await myShares.fetchMySharesPage({ cursor: undefined, search: "", signal });
    await myShares.fetchMySharesPage({ cursor: "next", search: "", signal });

    expect(first).toEqual({ shares: [share], nextCursor: "next" });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${origin}/api/me/shares`,
      `${origin}/api/me/shares?cursor=next`,
    ]);
  });

  it("should send the search with the cursor, and no q when the search is empty", async () => {
    const { fetch, myShares } = makeService(async () => makeJsonResponse({ shares: [], nextCursor: null }));

    await myShares.fetchMySharesPage({ cursor: "next", search: "soft deletes", signal });

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${origin}/api/me/shares?cursor=next&q=soft+deletes`]);
  });

  it("should read a null cursor as the last page", async () => {
    const { myShares } = makeService(async () => makeJsonResponse({ shares: [], nextCursor: null }));

    await expect(myShares.fetchMySharesPage({ cursor: undefined, search: "", signal })).resolves.toEqual({
      shares: [],
      nextCursor: undefined,
    });
  });

  it("should throw sign_in_required when the Worker refuses the session", async () => {
    const { myShares } = makeService(async () =>
      makeJsonResponse({ error: { code: "sign_in_required", message: "Sign in." } }, 401),
    );

    const failure = await myShares
      .fetchMySharesPage({ cursor: undefined, search: "", signal })
      .catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(MySharesError);
    expect(failure).toMatchObject({ code: "sign_in_required" });
  });

  it("should refuse a share whose listing state is unknown", async () => {
    const { myShares } = makeService(async () =>
      makeJsonResponse({ shares: [{ ...share, listing: { ...share.listing, state: "hidden" } }], nextCursor: null }),
    );

    await expect(myShares.fetchMySharesPage({ cursor: undefined, search: "", signal })).rejects.toMatchObject({
      code: "shares_unavailable",
    });
  });
});
