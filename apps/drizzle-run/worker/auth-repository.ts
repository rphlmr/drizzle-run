import { and, eq, gt, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { D1Database } from "./platform";
import { sessions, users } from "./schema";

/** A `users` row. */
export type StoredUser = typeof users.$inferSelect;

/** The GitHub identity a sign-in returns. */
export interface GitHubIdentity {
  githubId: number;
  login: string;
  name: string | null;
}

/** A session with its user, as one lookup returns them. */
export interface StoredSession {
  tokenHash: string;
  expiresAt: string;
  user: StoredUser;
}

/** The signed-in users and their sessions in D1. */
export interface AuthRepository {
  /** Creates the user on first sign-in, or refreshes their login and name. Returns the stored row. */
  upsertUser(identity: GitHubIdentity, user: { id: string; now: string }): Promise<StoredUser>;
  /** Stores a session, and drops this user's expired ones in the same transaction. */
  insertSession(session: { tokenHash: string; userId: string; createdAt: string; expiresAt: string }): Promise<void>;
  /** The session and its user, expired or not; null when the token hash is unknown. */
  findSession(tokenHash: string): Promise<StoredSession | null>;
  /** Extends a due, unexpired session. Returns its current expiry, or null if it expired or was revoked. */
  renewSession(input: {
    tokenHash: string;
    now: string;
    renewBefore: string;
    expiresAt: string;
  }): Promise<string | null>;
  /** Removes an expired session only while it remains expired, so a concurrent renewal survives. */
  deleteExpiredSession(tokenHash: string, now: string): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;
}

/** Creates the auth repository on a D1 database. */
export function createD1AuthRepository(database: D1Database): AuthRepository {
  const db = drizzle(database);

  return {
    async upsertUser(identity, user): Promise<StoredUser> {
      const [row] = await db
        .insert(users)
        .values({
          id: user.id,
          githubId: identity.githubId,
          login: identity.login,
          name: identity.name,
          createdAt: user.now,
          updatedAt: user.now,
        })
        .onConflictDoUpdate({
          target: users.githubId,
          set: { login: identity.login, name: identity.name, updatedAt: user.now },
        })
        .returning();

      if (row === undefined) {
        throw new Error(`Expected the users upsert to return the row of GitHub user ${identity.githubId}`);
      }

      return row;
    },
    async insertSession(session): Promise<void> {
      await db.batch([
        db.delete(sessions).where(and(eq(sessions.userId, session.userId), lte(sessions.expiresAt, session.createdAt))),
        db.insert(sessions).values(session),
      ]);
    },
    async findSession(tokenHash): Promise<StoredSession | null> {
      const row = await db
        .select({ tokenHash: sessions.tokenHash, expiresAt: sessions.expiresAt, user: users })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(sessions.tokenHash, tokenHash))
        .limit(1)
        .get();

      return row ?? null;
    },
    async renewSession({ tokenHash, now, renewBefore, expiresAt }): Promise<string | null> {
      const active = and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now));
      const [, current] = await db.batch([
        db
          .update(sessions)
          .set({ expiresAt })
          .where(and(active, lte(sessions.expiresAt, renewBefore))),
        db.select({ expiresAt: sessions.expiresAt }).from(sessions).where(active).limit(1),
      ]);

      return current[0]?.expiresAt ?? null;
    },
    async deleteSession(tokenHash): Promise<void> {
      await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    },
    async deleteExpiredSession(tokenHash, now): Promise<void> {
      await db.delete(sessions).where(and(eq(sessions.tokenHash, tokenHash), lte(sessions.expiresAt, now)));
    },
  };
}
