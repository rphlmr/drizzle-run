import { createHash } from "node:crypto";

import type { SqliteD1 } from "./sqlite-d1";

/** A signed-in test account: its user row and the cookie header its browser sends over HTTPS. */
export interface TestSession {
  userId: string;
  githubId: number;
  login: string;
  cookie: string;
}

/** The cookie header the browser of `login`, signed in by `seedTestSession`, sends over HTTPS. */
export function getTestSessionCookie(login = "octocat"): string {
  return `__Host-drizzle-run-session=${toTestSessionToken(login)}`;
}

function toTestSessionToken(login: string): string {
  return createHash("sha256").update(login).digest("base64url").slice(0, 43);
}

/**
 * Seed a GitHub user and an unexpired session
 *
 * For Worker tests only: writes the rows a real sign-in would, so routes read the session through the real cookie
 * lookup. The token is derived from the login, so each account gets its own cookie. Seeding the same account again
 * changes nothing.
 */
export function seedTestSession(
  database: SqliteD1,
  { login = "octocat", githubId = 583231, expiresAt = "2099-01-01T00:00:00.000Z" } = {},
): TestSession {
  const userId = `00000000-0000-4000-9000-${String(githubId).padStart(12, "0")}`;
  const token = toTestSessionToken(login);
  const tokenHash = createHash("sha256").update(token).digest("hex");

  database.sqlite
    .prepare(
      "INSERT OR IGNORE INTO users (id, github_id, login, name, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)",
    )
    .run(userId, githubId, login, "2026-10-17T00:00:00.000Z", "2026-10-17T00:00:00.000Z");
  database.sqlite
    .prepare("INSERT OR IGNORE INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(tokenHash, userId, "2026-10-17T00:00:00.000Z", expiresAt);

  return { userId, githubId, login, cookie: getTestSessionCookie(login) };
}
