import * as z from "zod/mini";

/** A GitHub username. */
export const GithubLoginSchema = z.string().check(z.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/));

/** An avatar on GitHub's avatar host: attacker-controlled content may never point an image anywhere else. */
export const GithubAvatarUrlSchema = z
  .string()
  .check(z.regex(/^https:\/\/avatars\.githubusercontent\.com\/u\/\d+\?v=4$/));

/** The signed-in GitHub account, as the page may show it. */
export const AccountUserSchema = z.object({
  /** GitHub's numeric id: unlike the login it never changes, so per-account state in this browser is keyed by it. */
  githubId: z.int().check(z.gte(1)),
  login: GithubLoginSchema,
  name: z.nullable(z.string()),
  avatarUrl: GithubAvatarUrlSchema,
});

/** The signed-in GitHub account, as the page may show it. */
export type AccountUser = z.output<typeof AccountUserSchema>;

/** `GET /api/auth/session`: whether this deployment offers sign-in, and who is signed in. */
export const AuthSessionSchema = z.object({
  configured: z.boolean(),
  user: z.nullable(AccountUserSchema),
});

/** Whether this deployment offers sign-in, and who is signed in. */
export type AuthSession = z.output<typeof AuthSessionSchema>;

/** GitHub sign-in as the page uses it. */
export interface AuthService {
  /** Read the session: whether sign-in is set up here and the signed-in account, or null when signed out. */
  fetchSession(request: { signal: AbortSignal }): Promise<AuthSession>;
  /** Sign out: the Worker deletes the session and clears its cookie. */
  signOut(request: { signal: AbortSignal }): Promise<void>;
  /**
   * Get the address that starts GitHub sign-in
   *
   * @param returnTo - The path to come back to, such as `/p/abc?file=query.ts`. The Worker keeps same-origin paths
   * only.
   */
  getSignInUrl(returnTo: string): string;
}
