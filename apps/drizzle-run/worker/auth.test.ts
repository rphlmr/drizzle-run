import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { seedTestSession } from "../test/worker/sessions";
import { SqliteD1 } from "../test/worker/sqlite-d1";
import { fetchWorker } from "../test/worker/worker-app";
import { resolveReturnPath, sessionLifetimeMs, type AuthServices } from "./auth";
import { createD1AuthRepository } from "./auth-repository";
import type { RateLimitBinding, WorkerEnvironment } from "./platform";

const origin = "https://run.test";
const githubToken = "gho_test_token_never_leaves_the_worker";

function makeEnvironment(database: SqliteD1, options: { configured?: boolean; rateLimit?: RateLimitBinding } = {}) {
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
    ...(options.configured === false ? {} : { GITHUB_CLIENT_ID: "Iv1.test", GITHUB_CLIENT_SECRET: "test-secret" }),
    ...(options.rateLimit === undefined ? {} : { AUTH_RATE_LIMIT: options.rateLimit }),
  } satisfies WorkerEnvironment;
}

/** A fake GitHub: records requests, exchanges one code for a token, and returns one user. */
function createGitHub({
  user = { id: 583231, login: "octocat", name: "The Octocat" },
  exchange = "ok",
}: { user?: Record<string, unknown>; exchange?: "ok" | "refused" } = {}) {
  const requests: { url: string; init: RequestInit }[] = [];

  async function fetchGitHub(url: string, init: RequestInit): Promise<Response> {
    requests.push({ url, init });

    if (url === "https://github.com/login/oauth/access_token") {
      return exchange === "ok"
        ? Response.json({ access_token: githubToken, token_type: "bearer", scope: "" })
        : Response.json({ error: "bad_verification_code" });
    }

    if (url === "https://api.github.com/user") {
      return new Headers(init.headers).get("authorization") === `Bearer ${githubToken}`
        ? Response.json(user)
        : new Response(null, { status: 401 });
    }

    return new Response(null, { status: 404 });
  }

  return { requests, fetchGitHub };
}

function createServices(fetchGitHub: AuthServices["fetch"], now = new Date("2026-10-17T10:00:00.000Z")): AuthServices {
  let nextToken = 0;

  return {
    now: () => now,
    newId: () => "00000000-0000-4000-8000-000000000001",
    randomToken: () => String(++nextToken).padStart(43, "t"),
    fetch: fetchGitHub,
    repository: createD1AuthRepository,
  };
}

/** The cookie pairs a response sets, as a `Cookie` header would send them back. */
function toCookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

async function startSignIn(env: WorkerEnvironment, services: AuthServices, returnTo = "/projects") {
  const response = await fetchWorker(
    new Request(`${origin}/api/auth/github/login?returnTo=${encodeURIComponent(returnTo)}`),
    env,
    { auth: services },
  );
  const location = new URL(response.headers.get("location") ?? "");

  return { response, location, cookie: toCookieHeader(response), state: location.searchParams.get("state") ?? "" };
}

function makeCallbackRequest({
  state,
  code = "github-code",
  cookie,
}: {
  state: string;
  code?: string;
  cookie: string;
}) {
  const query = new URLSearchParams({ state, ...(code === "" ? {} : { code }) });
  return new Request(`${origin}/api/auth/github/callback?${query}`, { headers: { cookie } });
}

function countSessions(database: SqliteD1): number {
  return (database.sqlite.prepare("SELECT count(*) AS count FROM sessions").get() as { count: number }).count;
}

describe("startGitHubSignIn", () => {
  it("should redirect to GitHub with state, an S256 challenge and the callback URL", async () => {
    const env = makeEnvironment(new SqliteD1());
    const { fetchGitHub } = createGitHub();

    const { response, location } = await startSignIn(env, createServices(fetchGitHub));

    expect(response.status).toBe(302);
    expect(`${location.origin}${location.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(location.searchParams)).toEqual({
      client_id: "Iv1.test",
      redirect_uri: "https://run.test/api/auth/github/callback",
      state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: "S256",
      allow_signup: "true",
    });
    expect(location.searchParams.has("scope")).toBe(false);
    expect(response.headers.get("set-cookie")).toMatch(
      /^__Host-drizzle-run-oauth=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/,
    );
  });

  it("should use plain cookies on a loopback http host and refuse other http hosts", async () => {
    const env = makeEnvironment(new SqliteD1());
    const services = createServices(createGitHub().fetchGitHub);

    const loopback = await fetchWorker(new Request("http://127.0.0.1:4173/api/auth/github/login"), env, {
      auth: services,
    });
    const plainHttp = await fetchWorker(new Request("http://run.test/api/auth/github/login"), env, { auth: services });

    expect(loopback.status).toBe(302);
    expect(loopback.headers.get("set-cookie")).toMatch(/^drizzle-run-oauth=[^;]+; Path=\/; HttpOnly; SameSite=Lax;/);
    expect(plainHttp.status).toBe(400);
    expect(plainHttp.headers.get("set-cookie")).toBeNull();
  });

  it("should refuse HEAD on the sign-in routes instead of starting a sign-in", async () => {
    const keys: string[] = [];
    const env = makeEnvironment(new SqliteD1(), {
      rateLimit: {
        async limit({ key }) {
          keys.push(key);
          return { success: true };
        },
      },
    });
    const services = createServices(createGitHub().fetchGitHub);

    for (const path of ["/api/auth/github/login", "/api/auth/github/callback?code=c&state=s"]) {
      const response = await fetchWorker(new Request(`${origin}${path}`, { method: "HEAD" }), env, { auth: services });

      expect(response.status, path).toBe(405);
      expect(response.headers.get("allow"), path).toBe("GET");
      expect(response.headers.get("set-cookie"), path).toBeNull();
    }

    const post = await fetchWorker(new Request(`${origin}/api/auth/github/login`, { method: "POST" }), env, {
      auth: services,
    });

    expect(post.headers.get("allow")).toBe("GET");
    expect(keys).toEqual([]);
  });

  it("should answer 503 when no GitHub App is configured", async () => {
    const env = makeEnvironment(new SqliteD1(), { configured: false });

    const response = await fetchWorker(new Request(`${origin}/api/auth/github/login`), env, {
      auth: createServices(createGitHub().fetchGitHub),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
  });

  it("should rate limit sign-ins under their own key", async () => {
    const keys: string[] = [];
    const env = makeEnvironment(new SqliteD1(), {
      rateLimit: {
        async limit({ key }) {
          keys.push(key);
          return { success: false };
        },
      },
    });

    const login = (address: string) =>
      fetchWorker(new Request(`${origin}/api/auth/github/login`, { headers: { "cf-connecting-ip": address } }), env, {
        auth: createServices(createGitHub().fetchGitHub),
      });

    const response = await login("203.0.113.9");
    await login("2001:db8:85a3:42::1");

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(keys).toEqual(["auth:ip:203.0.113.9", "auth:ip:2001:db8:85a3:42::/64"]);
  });
});

describe("finishGitHubSignIn", () => {
  it("should not rate limit the callback: the login step counted the sign-in", async () => {
    const database = new SqliteD1();
    const services = createServices(createGitHub().fetchGitHub);
    const started = await startSignIn(makeEnvironment(database), services);
    const keys: string[] = [];
    const limitedEnv = makeEnvironment(database, {
      rateLimit: {
        async limit({ key }) {
          keys.push(key);
          return { success: false };
        },
      },
    });

    const response = await fetchWorker(makeCallbackRequest(started), limitedEnv, { auth: services });

    expect(response.status).toBe(302);
    expect(keys).toEqual([]);
    expect(countSessions(database)).toBe(1);
  });

  it("should exchange the code with the PKCE verifier, start a session and drop the GitHub token", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const github = createGitHub();
    const services = createServices(github.fetchGitHub);
    const started = await startSignIn(env, services, "/s/abc?tab=output#run");

    const response = await fetchWorker(makeCallbackRequest(started), env, { auth: services });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/s/abc?tab=output#run");

    const exchangeBody = github.requests[0]?.init.body;
    const exchange = JSON.parse(typeof exchangeBody === "string" ? exchangeBody : "{}") as Record<string, string>;
    const verifier = exchange.code_verifier ?? "";
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      started.location.searchParams.get("code_challenge"),
    );
    expect(exchange).toMatchObject({
      client_id: "Iv1.test",
      client_secret: "test-secret",
      code: "github-code",
      redirect_uri: "https://run.test/api/auth/github/callback",
    });

    const cookies = response.headers.getSetCookie();
    expect(cookies[0]).toMatch(/^__Host-drizzle-run-oauth=; .*Max-Age=0$/);
    expect(cookies[1]).toMatch(
      new RegExp(
        `^__Host-drizzle-run-session=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; Secure; SameSite=Lax; ` +
          `Max-Age=${sessionLifetimeMs / 1000}$`,
      ),
    );
    expect(JSON.stringify([...response.headers])).not.toContain(githubToken);
    expect(JSON.stringify(database.sqlite.prepare("SELECT * FROM sessions").all())).not.toContain(githubToken);

    const session = await fetchWorker(
      new Request(`${origin}/api/auth/session`, { headers: { cookie: toCookieHeader(response) } }),
      env,
      { auth: services },
    );
    expect(await session.json()).toEqual({
      configured: true,
      user: {
        githubId: 583231,
        login: "octocat",
        name: "The Octocat",
        avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
      },
    });
  });

  it("should refuse a state that does not match the cookie, or a missing cookie, without calling GitHub", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const github = createGitHub();
    const services = createServices(github.fetchGitHub);
    const started = await startSignIn(env, services);

    const forged = await fetchWorker(makeCallbackRequest({ ...started, state: "f".repeat(43) }), env, {
      auth: services,
    });
    const noCookie = await fetchWorker(makeCallbackRequest({ ...started, cookie: "" }), env, { auth: services });

    expect(forged.status).toBe(400);
    expect(noCookie.status).toBe(400);
    expect(forged.headers.getSetCookie()).toEqual([expect.stringMatching(/^__Host-drizzle-run-oauth=; .*Max-Age=0$/)]);
    expect(github.requests).toEqual([]);
    expect(countSessions(database)).toBe(0);
  });

  it("should go back signed out when the person cancels on GitHub", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const github = createGitHub();
    const services = createServices(github.fetchGitHub);
    const started = await startSignIn(env, services, "/community");

    const response = await fetchWorker(makeCallbackRequest({ ...started, code: "" }), env, { auth: services });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/community");
    expect(github.requests).toEqual([]);
    expect(countSessions(database)).toBe(0);
  });

  it("should fail with 502 when GitHub refuses the code or returns an invalid user", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const refused = createServices(createGitHub({ exchange: "refused" }).fetchGitHub);
    const invalid = createServices(createGitHub({ user: { id: "1", login: "<script>" } }).fetchGitHub);

    const first = await fetchWorker(makeCallbackRequest(await startSignIn(env, refused)), env, { auth: refused });
    const second = await fetchWorker(makeCallbackRequest(await startSignIn(env, invalid)), env, { auth: invalid });

    expect(first.status).toBe(502);
    expect(second.status).toBe(502);
    expect(await second.text()).not.toContain("<script>");
    expect(countSessions(database)).toBe(0);
  });

  it("should keep one user per GitHub id and refresh a renamed login", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const first = createServices(createGitHub().fetchGitHub);
    const renamed = createServices(
      createGitHub({ user: { id: 583231, login: "octo-renamed", name: null } }).fetchGitHub,
    );

    await fetchWorker(makeCallbackRequest(await startSignIn(env, first)), env, { auth: first });
    await fetchWorker(makeCallbackRequest(await startSignIn(env, renamed)), env, { auth: renamed });

    expect(database.sqlite.prepare("SELECT github_id, login, name FROM users").all()).toEqual([
      { github_id: 583231, login: "octo-renamed", name: null },
    ]);
  });

  it("should replace this browser's previous session when signing in again", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const previous = seedTestSession(database);
    const services = createServices(createGitHub().fetchGitHub);
    const started = await startSignIn(env, services);

    await fetchWorker(makeCallbackRequest({ ...started, cookie: `${started.cookie}; ${previous.cookie}` }), env, {
      auth: services,
    });

    expect(countSessions(database)).toBe(1);
  });
});

describe("readSession", () => {
  it("should renew an active session after a day and align its cookie with the stored expiry", async () => {
    const database = new SqliteD1();
    const now = new Date("2026-10-17T10:00:00.000Z");
    const signedIn = seedTestSession(database, { expiresAt: "2026-11-15T10:00:00.000Z" });
    const services = createServices(createGitHub().fetchGitHub, now);
    const request = () => new Request(`${origin}/api/auth/session`, { headers: { cookie: signedIn.cookie } });
    const repository = createD1AuthRepository(database);
    const tokenHash = createHash("sha256")
      .update(signedIn.cookie.slice(signedIn.cookie.indexOf("=") + 1))
      .digest("hex");

    const response = await fetchWorker(request(), makeEnvironment(database), { auth: services });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { githubId: signedIn.githubId } });
    expect(response.headers.get("set-cookie")).toBe(
      `${signedIn.cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${sessionLifetimeMs / 1000}`,
    );
    expect((await repository.findSession(tokenHash))?.expiresAt).toBe("2026-11-16T10:00:00.000Z");

    now.setTime(now.getTime() + 60_000);
    const unchanged = await fetchWorker(request(), makeEnvironment(database), { auth: services });

    expect(unchanged.headers.get("set-cookie")).toBeNull();
    expect((await repository.findSession(tokenHash))?.expiresAt).toBe("2026-11-16T10:00:00.000Z");

    now.setTime(now.getTime() + 24 * 60 * 60 * 1000);
    const renewed = await fetchWorker(request(), makeEnvironment(database), { auth: services });

    expect(renewed.headers.get("set-cookie")).toContain(`Max-Age=${sessionLifetimeMs / 1000}`);
    expect((await repository.findSession(tokenHash))?.expiresAt).toBe("2026-11-17T10:01:00.000Z");
  });

  it("should let concurrent tabs renew the same session without shortening it", async () => {
    const database = new SqliteD1();
    const signedIn = seedTestSession(database, { expiresAt: "2026-10-18T10:00:00.000Z" });
    const services = createServices(createGitHub().fetchGitHub);
    const repository = createD1AuthRepository(database);
    const bothRead = Promise.withResolvers<void>();
    let reads = 0;
    services.repository = () => ({
      ...repository,
      async findSession(tokenHash) {
        const found = await repository.findSession(tokenHash);

        if (++reads === 2) {
          bothRead.resolve();
        }

        await bothRead.promise;

        return found;
      },
    });
    const request = () => new Request(`${origin}/api/auth/session`, { headers: { cookie: signedIn.cookie } });

    const responses = await Promise.all([
      fetchWorker(request(), makeEnvironment(database), { auth: services }),
      fetchWorker(request(), makeEnvironment(database), { auth: services }),
    ]);

    for (const response of responses) {
      expect(await response.json()).toMatchObject({ user: { githubId: signedIn.githubId } });
      expect(response.headers.get("set-cookie")).toContain(`Max-Age=${sessionLifetimeMs / 1000}`);
    }

    expect(countSessions(database)).toBe(1);
  });

  it("should not revive a session revoked after its lookup", async () => {
    const database = new SqliteD1();
    const signedIn = seedTestSession(database, { expiresAt: "2026-10-18T10:00:00.000Z" });
    const services = createServices(createGitHub().fetchGitHub);
    const repository = createD1AuthRepository(database);
    services.repository = () => ({
      ...repository,
      async findSession(tokenHash) {
        const found = await repository.findSession(tokenHash);
        await repository.deleteSession(tokenHash);

        return found;
      },
    });

    const response = await fetchWorker(
      new Request(`${origin}/api/auth/session`, { headers: { cookie: signedIn.cookie } }),
      makeEnvironment(database),
      { auth: services },
    );

    expect(await response.json()).toEqual({ configured: true, user: null });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(countSessions(database)).toBe(0);
  });

  it("should refuse renewal at the expiry boundary", async () => {
    const database = new SqliteD1();
    const now = new Date("2026-10-17T10:00:00.000Z");
    const signedIn = seedTestSession(database, { expiresAt: "2026-10-17T10:00:00.001Z" });
    const services = createServices(createGitHub().fetchGitHub, now);
    const repository = createD1AuthRepository(database);
    services.repository = () => ({
      ...repository,
      async findSession(tokenHash) {
        const found = await repository.findSession(tokenHash);
        now.setTime(now.getTime() + 1);

        return found;
      },
    });

    const response = await fetchWorker(
      new Request(`${origin}/api/auth/session`, { headers: { cookie: signedIn.cookie } }),
      makeEnvironment(database),
      { auth: services },
    );

    expect(await response.json()).toEqual({ configured: true, user: null });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(countSessions(database)).toBe(0);
  });

  it("should not set a renewed cookie when saving the renewal fails", async () => {
    const database = new SqliteD1();
    const signedIn = seedTestSession(database, { expiresAt: "2026-10-18T10:00:00.000Z" });
    const services = createServices(createGitHub().fetchGitHub);
    services.repository = () => ({
      ...createD1AuthRepository(database),
      async renewSession() {
        throw new Error("D1 unavailable");
      },
    });

    const response = await fetchWorker(
      new Request(`${origin}/api/auth/session`, { headers: { cookie: signedIn.cookie } }),
      makeEnvironment(database),
      { auth: services },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(countSessions(database)).toBe(1);
  });

  it("should report signed out without a cookie, with an unknown token, and whether sign-in is set up", async () => {
    const database = new SqliteD1();
    const services = createServices(createGitHub().fetchGitHub);

    const none = await fetchWorker(new Request(`${origin}/api/auth/session`), makeEnvironment(database), {
      auth: services,
    });
    const unknown = await fetchWorker(
      new Request(`${origin}/api/auth/session`, {
        headers: { cookie: `__Host-drizzle-run-session=${"u".repeat(43)}` },
      }),
      makeEnvironment(database, { configured: false }),
      { auth: services },
    );

    expect(none.headers.get("cache-control")).toBe("no-store");
    expect(await none.json()).toEqual({ configured: true, user: null });
    expect(await unknown.json()).toEqual({ configured: false, user: null });
  });

  it("should treat an expired session as signed out and delete it", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const expired = seedTestSession(database, { expiresAt: "2026-10-17T09:59:59.999Z" });

    const response = await fetchWorker(
      new Request(`${origin}/api/auth/session`, { headers: { cookie: expired.cookie } }),
      env,
      { auth: createServices(createGitHub().fetchGitHub) },
    );

    expect(await response.json()).toEqual({ configured: true, user: null });
    expect(countSessions(database)).toBe(0);
  });
});

describe("signOut", () => {
  it("should refuse a cross-site request and keep the session", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const signedIn = seedTestSession(database);
    const services = createServices(createGitHub().fetchGitHub);

    const crossSite = await fetchWorker(
      new Request(`${origin}/api/auth/logout`, {
        method: "POST",
        headers: { origin: "https://evil.test", "sec-fetch-site": "cross-site", cookie: signedIn.cookie },
      }),
      env,
      { auth: services },
    );
    const noOrigin = await fetchWorker(
      new Request(`${origin}/api/auth/logout`, {
        method: "POST",
        headers: { cookie: signedIn.cookie },
      }),
      env,
      { auth: services },
    );

    expect(crossSite.status).toBe(403);
    expect(noOrigin.status).toBe(403);
    expect(countSessions(database)).toBe(1);
  });

  it("should delete the session row and clear the cookie, so the same cookie no longer signs in", async () => {
    const database = new SqliteD1();
    const env = makeEnvironment(database);
    const signedIn = seedTestSession(database);
    const services = createServices(createGitHub().fetchGitHub);

    const response = await fetchWorker(
      new Request(`${origin}/api/auth/logout`, {
        method: "POST",
        headers: { origin, "sec-fetch-site": "same-origin", cookie: signedIn.cookie },
      }),
      env,
      { auth: services },
    );
    const after = await fetchWorker(
      new Request(`${origin}/api/auth/session`, { headers: { cookie: signedIn.cookie } }),
      env,
      { auth: services },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toMatch(/^__Host-drizzle-run-session=; .*Max-Age=0$/);
    expect(countSessions(database)).toBe(0);
    expect(await after.json()).toEqual({ configured: true, user: null });
  });
});

describe("resolveReturnPath", () => {
  it("should keep same-origin paths and turn everything else into /", () => {
    expect(resolveReturnPath("/s/abc/v/2?x=1#y", origin)).toBe("/s/abc/v/2?x=1#y");
    expect(resolveReturnPath(null, origin)).toBe("/");
    expect(resolveReturnPath("https://evil.test/", origin)).toBe("/");
    expect(resolveReturnPath("//evil.test/", origin)).toBe("/");
    expect(resolveReturnPath("/.//evil.test/", origin)).toBe("/");
    expect(resolveReturnPath("/a/..//evil.test/", origin)).toBe("/");
    expect(resolveReturnPath("/\\evil.test/", origin)).toBe("/");
    expect(resolveReturnPath("javascript:alert(1)", origin)).toBe("/");
    expect(resolveReturnPath(`/${"a".repeat(600)}`, origin)).toBe("/");
  });
});
