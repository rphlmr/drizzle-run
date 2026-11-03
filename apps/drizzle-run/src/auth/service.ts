import { getFieldIssueMessage, type Fetch } from "../lib/api";
import { AuthSessionSchema, type AuthService } from "./contract";

/** What sign-in needs: the network and the origin it runs on. */
export interface AuthServiceDependencies {
  /** Sends every request; the browser's `fetch` in the app, a fake in tests. */
  fetch: Fetch;
  /** The Drizzle Run origin requests go to, such as `https://drizzle.run`. */
  origin: string;
}

/** Create the sign-in API, sending every request to `origin`. */
export function createAuthService({ fetch, origin }: AuthServiceDependencies): AuthService {
  const toUrl = (path: string) => new URL(path, origin).href;

  return {
    async fetchSession({ signal }) {
      const response = await fetch(toUrl("/api/auth/session"), { headers: { accept: "application/json" }, signal });

      if (!response.ok) {
        throw new Error("Your sign-in could not be checked right now. Try again.");
      }

      const parsed = AuthSessionSchema.safeParse(await response.json().catch(() => undefined));

      if (!parsed.success) {
        throw new Error(
          getFieldIssueMessage(
            parsed.error,
            { user: "Drizzle Run returned an invalid account." },
            "Drizzle Run returned an invalid session.",
          ),
        );
      }

      return parsed.data;
    },

    async signOut({ signal }) {
      const response = await fetch(toUrl("/api/auth/logout"), {
        method: "POST",
        headers: { accept: "application/json" },
        signal,
      });

      if (!response.ok) {
        throw new Error("You could not be signed out right now. Try again.");
      }
    },

    getSignInUrl(returnTo) {
      return toUrl(`/api/auth/github/login?${new URLSearchParams({ returnTo })}`);
    },
  };
}
