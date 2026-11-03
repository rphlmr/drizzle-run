import * as z from "zod/mini";

import { createD1AuthRepository, type AuthRepository, type GitHubIdentity } from "./auth-repository";
import { checkRateLimit, createApiError, fromBase64UrlText, isSameHash, toBase64Url } from "./http";
import { logWorkerFailure } from "./logger";
import type { WorkerEnvironment } from "./platform";
import {
  hashSessionToken,
  readCookie,
  readRequestSession,
  resolveCookieScheme,
  serializeCookie,
  tokenPattern,
  toPublicUser,
  type CookieScheme,
} from "./session";
import type { InputRefusal } from "./validation";

// The GitHub access token is read once and dropped: never stored, never sent to the page, never given to connect
// agents. D1 keeps only the SHA-256 of the session token.

/** Sessions expire thirty days after issuance or their latest activity-based renewal. */
export const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000; // 30 days
const sessionRenewalIntervalMs = 24 * 60 * 60 * 1000; // at most one D1 update per day
/** How long the GitHub round trip may take before its state cookie expires. */
const oauthCookieLifetimeSeconds = 10 * 60;
const githubRequestTimeoutMs = 10_000;
/** GitHub's answer to the code exchange; only its token is read. */
const GitHubTokenResponseSchema = z.object({ access_token: z.string().check(z.minLength(1)) });

/** GitHub's `GET /user`, checked field by field so each field keeps its own error. */
const GitHubUserSchema = z.object({ id: z.unknown(), login: z.unknown(), name: z.catch(z.string(), "") });
const GitHubIdSchema = z.int().check(z.positive());
const GitHubLoginSchema = z.string().check(z.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/));
/** The login step's cookie: `<state>.<verifier>.<base64url return path>`, nothing more. */
const OAuthCookieSchema = z.tuple([
  z.string().check(z.regex(tokenPattern)),
  z.string().check(z.regex(tokenPattern)),
  z.string(),
]);
const maxReturnPathLength = 512;

/** The sign-in link's query, such as `?returnTo=/projects`. */
export const SignInQuerySchema = z.object({ returnTo: z.optional(z.string()) });
/** GitHub's redirect back, such as `?state=...&code=...`; no code when the visitor declined. */
export const SignInCallbackQuerySchema = z.object({ state: z.optional(z.string()), code: z.optional(z.string()) });

export const invalidSignInQuery = {
  status: 400,
  code: "invalid_query",
  message: "This sign-in link is invalid.",
} satisfies InputRefusal;

const textEncoder = new TextEncoder();

/** What the auth routes depend on: the clock, ids, randomness, GitHub's HTTP API and the repository. */
export interface AuthServices {
  now(): Date;
  newId(): string;
  /** 32 random bytes as base64url: state, PKCE verifiers and session tokens. */
  randomToken(): string;
  fetch(url: string, init: RequestInit): Promise<Response>;
  repository(database: WorkerEnvironment["PLAYGROUNDS"]): AuthRepository;
}

/** The sign-in services the Worker runs with: the clock, random ids and tokens, GitHub over `fetch`, and D1. */
export function createD1AuthServices(): AuthServices {
  return {
    now: () => new Date(),
    newId: () => crypto.randomUUID(),
    randomToken: () => toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    fetch: (url, init) => fetch(url, init),
    repository: createD1AuthRepository,
  };
}

/** The PKCE S256 challenge of a verifier. */
async function createCodeChallenge(verifier: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(verifier))));
}

/**
 * Resolve where to go after sign-in
 *
 * Only a path on this origin is kept, so the callback can never redirect elsewhere. Anything else, including `//host`
 * and backslash tricks, becomes `/`.
 */
export function resolveReturnPath(value: string | null, origin: string): string {
  if (value === null || value.length > maxReturnPathLength || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }

  try {
    const target = new URL(value, origin);

    if (target.origin !== origin || value.includes("\\")) {
      return "/";
    }

    const path = `${target.pathname}${target.search}${target.hash}`;

    // Dot segments can normalize to a protocol-relative path, such as `/.//host` to `//host`.
    if (path.startsWith("//")) {
      return "/";
    }

    return path;
  } catch {
    return "/";
  }
}

/** GitHub's endpoints. The e2e overrides may carry a path prefix, so paths are appended, never resolved. */
function getGitHubUrls(environment: WorkerEnvironment) {
  const oauth = (environment.GITHUB_OAUTH_URL ?? "https://github.com").replace(/\/+$/, "");
  const api = (environment.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");

  return {
    authorize: `${oauth}/login/oauth/authorize`,
    accessToken: `${oauth}/login/oauth/access_token`,
    user: `${api}/user`,
  };
}

/** Whether this deployment has a GitHub App configured. */
export function isSignInConfigured(environment: WorkerEnvironment): boolean {
  return Boolean(environment.GITHUB_CLIENT_ID) && Boolean(environment.GITHUB_CLIENT_SECRET);
}

function getCallbackUrl(request: Request): string {
  return new URL("/api/auth/github/callback", request.url).href;
}

/** A small page for a sign-in that cannot finish. Its text is fixed, never taken from the request. */
function createSignInErrorPage(status: number, message: string, headers: Headers = new Headers()): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");

  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>Sign-in failed · Drizzle Run</title>` +
      `<main style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem">` +
      `<h1>Sign-in failed</h1><p>${message}</p><p><a href="/">Back to Drizzle Run</a></p></main>`,
    { status, headers },
  );
}

/** `GET /api/auth/github/login?returnTo=/path`: starts the GitHub App web flow with state and PKCE. */
export async function startGitHubSignIn(
  request: Request,
  environment: WorkerEnvironment,
  { returnTo }: z.output<typeof SignInQuerySchema>,
  services: AuthServices,
): Promise<Response> {
  const url = new URL(request.url);
  const scheme = resolveCookieScheme(url);

  if (scheme === null) {
    return createSignInErrorPage(400, "Sign in from the HTTPS address of Drizzle Run.");
  }

  if (!isSignInConfigured(environment)) {
    return createSignInErrorPage(503, "Sign-in is not set up on this deployment.");
  }

  const limited = await checkRateLimit(request, environment, "auth");

  if (limited !== undefined) {
    const retryAfter = limited.headers.get("retry-after");

    return createSignInErrorPage(
      limited.status,
      "Too many sign-in attempts. Try again in a minute.",
      new Headers(retryAfter === null ? {} : { "Retry-After": retryAfter }),
    );
  }

  const state = services.randomToken();
  const verifier = services.randomToken();
  const returnPath = resolveReturnPath(returnTo ?? null, url.origin);
  const authorize = new URL(getGitHubUrls(environment).authorize);
  authorize.search = new URLSearchParams({
    client_id: environment.GITHUB_CLIENT_ID ?? "",
    redirect_uri: getCallbackUrl(request),
    state,
    code_challenge: await createCodeChallenge(verifier),
    code_challenge_method: "S256",
    allow_signup: "true",
  }).toString();

  const oauthCookie = `${state}.${verifier}.${toBase64Url(textEncoder.encode(returnPath))}`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.href,
      "Set-Cookie": serializeCookie(scheme, scheme.oauth, oauthCookie, oauthCookieLifetimeSeconds),
      "Cache-Control": "no-store",
    },
  });
}

/** The state, PKCE verifier and return path the login step left in its cookie. */
function readOAuthCookie(request: Request, scheme: CookieScheme) {
  const parts = OAuthCookieSchema.safeParse((readCookie(request, scheme.oauth) ?? "").split("."));

  if (!parts.success) {
    return null;
  }

  const [state, verifier, encodedReturnPath] = parts.data;

  return { state, verifier, returnPath: fromBase64UrlText(encodedReturnPath) ?? "/" };
}

/** Thrown when GitHub refuses the code or answers with something unexpected. */
class GitHubSignInError extends Error {}

async function exchangeCode({
  environment,
  services,
  code,
  verifier,
  redirectUri,
}: {
  environment: WorkerEnvironment;
  services: AuthServices;
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<string> {
  const response = await services.fetch(getGitHubUrls(environment).accessToken, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "drizzle-run" },
    body: JSON.stringify({
      client_id: environment.GITHUB_CLIENT_ID,
      client_secret: environment.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(githubRequestTimeoutMs),
  });

  const body: unknown = response.ok ? await response.json() : null;
  const exchanged = GitHubTokenResponseSchema.safeParse(body);

  if (!exchanged.success) {
    throw new GitHubSignInError(`GitHub did not exchange the sign-in code (HTTP ${response.status}).`, {
      cause: exchanged.error,
    });
  }

  return exchanged.data.access_token;
}

async function readGitHubIdentity(environment: WorkerEnvironment, services: AuthServices, token: string) {
  const response = await services.fetch(getGitHubUrls(environment).user, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "drizzle-run",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(githubRequestTimeoutMs),
  });

  if (!response.ok) {
    throw new GitHubSignInError(`GitHub did not return the signed-in user (HTTP ${response.status}).`);
  }

  const body: unknown = await response.json();
  const user = GitHubUserSchema.safeParse(body);

  if (!user.success) {
    throw new GitHubSignInError("GitHub returned a user without an id or login.", { cause: user.error });
  }

  const id = GitHubIdSchema.safeParse(user.data.id);

  if (!id.success) {
    throw new GitHubSignInError("GitHub returned a user id that is not a positive integer.", { cause: id.error });
  }

  const login = GitHubLoginSchema.safeParse(user.data.login);

  if (!login.success) {
    throw new GitHubSignInError("GitHub returned a login that is not a GitHub username.", { cause: login.error });
  }

  const name = user.data.name.trim().slice(0, 255);

  return { githubId: id.data, login: login.data, name: name === "" ? null : name } satisfies GitHubIdentity;
}

/**
 * `GET /api/auth/github/callback`: finishes the GitHub round trip
 *
 * Checks the state against the login step's cookie, exchanges the code with the PKCE verifier, reads the public
 * identity, then starts a session. The GitHub token is dropped right after `GET /user`.
 */
export async function finishGitHubSignIn(
  request: Request,
  environment: WorkerEnvironment,
  { state = "", code }: z.output<typeof SignInCallbackQuerySchema>,
  services: AuthServices,
): Promise<Response> {
  const url = new URL(request.url);
  const scheme = resolveCookieScheme(url);

  if (scheme === null) {
    return createSignInErrorPage(400, "Sign in from the HTTPS address of Drizzle Run.");
  }

  // The state cookie is single use: every answer from here clears it.
  const headers = new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  headers.append("Set-Cookie", serializeCookie(scheme, scheme.oauth, "", 0));

  if (!isSignInConfigured(environment)) {
    return createSignInErrorPage(503, "Sign-in is not set up on this deployment.", headers);
  }

  // No rate limit here: the login step already counted this sign-in, and the state, PKCE verifier and single-use
  // cookie refuse a callback it did not start.
  const pending = readOAuthCookie(request, scheme);

  if (pending === null || !isSameHash(pending.state, state)) {
    return createSignInErrorPage(400, "This sign-in link expired or was not started here. Sign in again.", headers);
  }

  const returnPath = resolveReturnPath(pending.returnPath, url.origin);

  if (code === undefined || code === "") {
    headers.set("Location", returnPath);
    return new Response(null, { status: 302, headers });
  }

  let identity: GitHubIdentity;

  try {
    const token = await exchangeCode({
      environment,
      services,
      code,
      verifier: pending.verifier,
      redirectUri: getCallbackUrl(request),
    });
    identity = await readGitHubIdentity(environment, services, token);
  } catch (cause) {
    logWorkerFailure({
      event: "auth_callback_failed",
      cause,
      message: "Confirming a GitHub sign-in failed",
      request,
    });
    return createSignInErrorPage(502, "GitHub did not confirm the sign-in. Try again.", headers);
  }

  try {
    const repository = services.repository(environment.PLAYGROUNDS);
    const now = services.now();
    const user = await repository.upsertUser(identity, { id: services.newId(), now: now.toISOString() });
    const sessionToken = services.randomToken();
    const replacedToken = readCookie(request, scheme.session);

    if (replacedToken !== null && tokenPattern.test(replacedToken)) {
      await repository.deleteSession(await hashSessionToken(replacedToken));
    }

    await repository.insertSession({
      tokenHash: await hashSessionToken(sessionToken),
      userId: user.id,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + sessionLifetimeMs).toISOString(),
    });

    headers.append(
      "Set-Cookie",
      serializeCookie(scheme, scheme.session, sessionToken, Math.floor(sessionLifetimeMs / 1000)),
    );
    headers.set("Location", returnPath);

    return new Response(null, { status: 302, headers });
  } catch (cause) {
    logWorkerFailure({
      event: "session_save_failed",
      cause,
      message: "Saving a new session failed",
      request,
    });
    return createSignInErrorPage(503, "Your session could not be saved. Try again.", headers);
  }
}

/** `GET /api/auth/session`: whether sign-in is available here, and who is signed in. */
export async function readSession(
  request: Request,
  environment: WorkerEnvironment,
  services: AuthServices,
): Promise<Response> {
  const headers = new Headers({ "Cache-Control": "no-store" });

  try {
    const current = await readRequestSession(request, environment, services);
    let user = current?.session.user ?? null;

    if (current !== null) {
      const now = services.now();
      const renewBefore = new Date(now.getTime() + sessionLifetimeMs - sessionRenewalIntervalMs);

      if (Date.parse(current.session.expiresAt) <= renewBefore.getTime()) {
        const expiresAt = await services.repository(environment.PLAYGROUNDS).renewSession({
          tokenHash: current.session.tokenHash,
          now: now.toISOString(),
          renewBefore: renewBefore.toISOString(),
          expiresAt: new Date(now.getTime() + sessionLifetimeMs).toISOString(),
        });
        const maxAgeSeconds =
          expiresAt === null ? 0 : Math.floor((Date.parse(expiresAt) - services.now().getTime()) / 1000);

        if (maxAgeSeconds > 0) {
          headers.set(
            "Set-Cookie",
            serializeCookie(current.scheme, current.scheme.session, current.token, maxAgeSeconds),
          );
        } else {
          user = null;
        }
      }
    }

    return Response.json(
      {
        configured: isSignInConfigured(environment),
        user: user === null ? null : toPublicUser(user),
      },
      { headers },
    );
  } catch (cause) {
    logWorkerFailure({
      event: "session_read_failed",
      cause,
      message: "Checking the session failed",
      request,
    });
    return createApiError(503, "session_unavailable", "Your session could not be checked right now.");
  }
}

/** `POST /api/auth/logout`: deletes the session row and clears the cookie. Same origin only, so no page can sign you out. */
export async function signOut(
  request: Request,
  environment: WorkerEnvironment,
  services: AuthServices,
): Promise<Response> {
  const scheme = resolveCookieScheme(new URL(request.url));

  if (scheme === null) {
    return createApiError(400, "https_required", "Sign out from the HTTPS address of Drizzle Run.");
  }

  const token = readCookie(request, scheme.session);

  try {
    if (token !== null && tokenPattern.test(token)) {
      await services.repository(environment.PLAYGROUNDS).deleteSession(await hashSessionToken(token));
    }
  } catch (cause) {
    logWorkerFailure({ event: "sign_out_failed", cause, message: "Signing out failed", request });
    return createApiError(503, "session_unavailable", "You could not be signed out right now. Try again.");
  }

  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store", "Set-Cookie": serializeCookie(scheme, scheme.session, "", 0) },
  });
}
