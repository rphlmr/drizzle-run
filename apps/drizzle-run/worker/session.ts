import { createD1AuthRepository, type AuthRepository, type StoredSession, type StoredUser } from "./auth-repository";
import { digestTextHex } from "./hex-digest";
import type { WorkerEnvironment } from "./platform";

/** A session token, state or PKCE verifier: 32 random bytes as base64url. */
export const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

/** The signed-in user, as the Worker routes see it. */
export interface SessionUser {
  id: string;
  githubId: number;
  login: string;
  name: string | null;
}

/** What the page may know about the signed-in user. */
export interface PublicUser {
  // Unlike the login it never changes, so the page keys per-account state by it.
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string;
}

/** Cookie names and attributes for one request: `__Host-` and Secure over HTTPS, plain names on a loopback http host. */
export interface CookieScheme {
  session: string;
  oauth: string;
  attributes: string;
}

/** The cookie scheme of a request URL; null on plain http to a non-loopback host, where no cookie is safe. */
export function resolveCookieScheme(url: URL): CookieScheme | null {
  if (url.protocol === "https:") {
    return {
      session: "__Host-drizzle-run-session",
      oauth: "__Host-drizzle-run-oauth",
      attributes: "Path=/; HttpOnly; Secure; SameSite=Lax",
    };
  }

  // WebKit drops Secure cookies over http, so local dev and e2e use plain cookies, and only on a loopback host.
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname.endsWith(".localhost");

  if (url.protocol === "http:" && loopback) {
    return {
      session: "drizzle-run-session",
      oauth: "drizzle-run-oauth",
      attributes: "Path=/; HttpOnly; SameSite=Lax",
    };
  }

  return null;
}

/** One cookie's value from the request, or null. */
export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");

    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }

  return null;
}

/** A `Set-Cookie` value with the scheme's attributes. A max age of 0 clears the cookie. */
export function serializeCookie(scheme: CookieScheme, name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; ${scheme.attributes}; Max-Age=${maxAgeSeconds}`;
}

/** The SHA-256 of a session token, as hex: the only form D1 keeps. */
export function hashSessionToken(token: string): Promise<string> {
  return digestTextHex(token);
}

/** The public avatar of a GitHub account, built from its id so no stored URL is ever trusted. */
export function getAvatarUrl(githubId: number): string {
  return `https://avatars.githubusercontent.com/u/${githubId}?v=4`;
}

/** What the page may see of a stored user. */
export function toPublicUser(user: Pick<StoredUser, "githubId" | "login" | "name">): PublicUser {
  return { githubId: user.githubId, login: user.login, name: user.name, avatarUrl: getAvatarUrl(user.githubId) };
}

/** What reading a session depends on: the clock and the repository. */
export interface SessionServices {
  now(): Date;
  repository(database: WorkerEnvironment["PLAYGROUNDS"]): AuthRepository;
}

/** The session services the Worker runs with: the clock and D1. */
export function createD1SessionServices(): SessionServices {
  return {
    now: () => new Date(),
    repository: createD1AuthRepository,
  };
}

/** Reads the signed-in user of a request; the routes that need one take it as a service. */
export type ReadCurrentUser = (request: Request, environment: WorkerEnvironment) => Promise<SessionUser | null>;

/**
 * Read the signed-in user of a request
 *
 * Returns null without a valid, unexpired session cookie. An expired session is deleted on the way.
 */
export async function readSessionUser(
  request: Request,
  environment: WorkerEnvironment,
  services: SessionServices,
): Promise<SessionUser | null> {
  const current = await readRequestSession(request, environment, services);

  if (current === null) {
    return null;
  }

  const { id, githubId, login, name } = current.session.user;

  return { id, githubId, login, name };
}

/** A validated request session; its token is only used to renew the HttpOnly cookie. */
interface RequestSession {
  session: StoredSession;
  token: string;
  scheme: CookieScheme;
}

/** Returns the unexpired stored session and cookie information, or null when signed out. */
export async function readRequestSession(
  request: Request,
  environment: WorkerEnvironment,
  services: SessionServices,
): Promise<RequestSession | null> {
  const scheme = resolveCookieScheme(new URL(request.url));
  const token = scheme === null ? null : readCookie(request, scheme.session);

  if (scheme === null || token === null || !tokenPattern.test(token)) {
    return null;
  }

  const repository = services.repository(environment.PLAYGROUNDS);
  const tokenHash = await hashSessionToken(token);
  const session = await repository.findSession(tokenHash);

  if (session === null) {
    return null;
  }

  const now = services.now();

  if (Date.parse(session.expiresAt) <= now.getTime()) {
    await repository.deleteExpiredSession(tokenHash, now.toISOString());
    return null;
  }

  return { session, token, scheme };
}
