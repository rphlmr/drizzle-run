import { describe, expect, it, vi } from "vitest";

import type { Fetch } from "../lib/api";
import { createAuthService } from "./service";

const origin = "https://run.example.test";

function makeResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeService(fetch: Fetch) {
  return createAuthService({ fetch, origin });
}

const user = {
  githubId: 583231,
  login: "octocat",
  name: "The Octocat",
  avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
};

describe("auth service", () => {
  it("should read the session from the origin, with the caller's abort signal", async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn<Fetch>(async () => makeResponse({ configured: true, user }));

    await expect(makeService(fetchMock).fetchSession({ signal })).resolves.toEqual({ configured: true, user });
    expect(fetchMock).toHaveBeenCalledWith(`${origin}/api/auth/session`, expect.objectContaining({ signal }));
  });

  it("should refuse a session whose account is invalid", async () => {
    const fetchMock = vi.fn<Fetch>(async () => makeResponse({ configured: true, user: { ...user, githubId: 0 } }));

    await expect(makeService(fetchMock).fetchSession({ signal: new AbortController().signal })).rejects.toThrow(
      "Drizzle Run returned an invalid account.",
    );
  });

  it("should refuse a body that is not a session", async () => {
    const fetchMock = vi.fn<Fetch>(async () => makeResponse({ user: null }));

    await expect(makeService(fetchMock).fetchSession({ signal: new AbortController().signal })).rejects.toThrow(
      "Drizzle Run returned an invalid session.",
    );
  });

  it("should sign out with a POST that carries the caller's abort signal", async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn<Fetch>(async () => new Response(null, { status: 204 }));

    await makeService(fetchMock).signOut({ signal });

    expect(fetchMock).toHaveBeenCalledWith(
      `${origin}/api/auth/logout`,
      expect.objectContaining({ method: "POST", signal }),
    );
  });

  it("should build the GitHub sign-in address on the origin", () => {
    const service = makeService(vi.fn<Fetch>());

    expect(service.getSignInUrl("/p/abc?file=query.ts")).toBe(
      `${origin}/api/auth/github/login?returnTo=%2Fp%2Fabc%3Ffile%3Dquery.ts`,
    );
  });
});
