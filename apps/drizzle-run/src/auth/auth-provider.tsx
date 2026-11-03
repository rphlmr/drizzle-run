import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  useFetcher,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunctionArgs,
} from "react-router";

import { appServicesContext, useAppServices } from "../app-services";
import { getErrorText } from "../lib/error-text";
import type { AccountUser, AuthSession } from "./contract";
import { followSessionActivity } from "./session-activity";

/** The route that reads the session and signs out. */
export const SESSION_PATH = "/session";

/** The session as the session route read it. */
export type SessionData = { status: "loaded"; session: AuthSession } | { status: "failed"; error: string };

/** How a sign-out ended. */
export type SignOutResult = { status: "signed_out" } | { status: "failed"; error: string };

/** Read the session: whether this deployment offers sign-in, and who is signed in. */
export async function loadSession({ request, context }: LoaderFunctionArgs): Promise<SessionData> {
  try {
    const session = await context.get(appServicesContext).auth.fetchSession({ signal: request.signal });

    return { status: "loaded", session };
  } catch (cause) {
    return { status: "failed", error: getErrorText(cause) };
  }
}

/** Read the session again after a sign-out, which submits with revalidation off for every other route. */
export function shouldReloadSession({ formAction, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formAction === SESSION_PATH) {
    return true;
  }

  return defaultShouldRevalidate;
}

/** Sign out. The session reads again afterwards, so it shows who is signed in now. */
export async function signOut({ request, context }: ActionFunctionArgs): Promise<SignOutResult> {
  try {
    await context.get(appServicesContext).auth.signOut({ signal: request.signal });

    return { status: "signed_out" };
  } catch (cause) {
    return { status: "failed", error: getErrorText(cause) };
  }
}

/** What a view needs from sign-in: where it stands, the account, and the actions. */
export interface Auth {
  status: AuthStatus;
  user: AccountUser | null;
  /** Why the last sign-out failed, or empty. */
  error: string;
  /** Leaves for GitHub, then comes back to the current page. */
  signIn: () => void;
  signOut: () => void;
  retry: () => void;
  /** Reads the session again after the Worker refused it, so a session that ended shows as signed out. */
  reportSessionEnded: () => void;
}

/**
 * Where the tab's sign-in stands
 *
 * ```text
 * loading ─► unavailable          (no GitHub App on this deployment)
 *         ─► signedOut ─signIn─► redirecting (leaves for GitHub) ─page restored─► loading
 *         ─► signedIn ─signOut─► signingOut ─► loading ─► signedOut
 *                    │                                └► signedIn (error kept)
 *                    └reportSessionEnded─► signedIn (reading again) ─► signedOut | signedIn
 *         ─► failed ─retry─► loading
 * ```
 */
export type AuthStatus = "loading" | "unavailable" | "failed" | "signedOut" | "redirecting" | "signedIn" | "signingOut";

interface AuthStatusInput {
  redirecting: boolean;
  signingOut: boolean;
  readingSession: boolean;
  session: SessionData | undefined;
}

function isSignedIn(session: SessionData): boolean {
  return session.status === "loaded" && session.session.user !== null;
}

/**
 * Derive the sign-in status from the session read and the sign-out in flight
 *
 * A signed-in account stays signed in while the session reads again, so a read after an action never looks like a
 * sign-out.
 */
export function getAuthStatus({ redirecting, signingOut, readingSession, session }: AuthStatusInput): AuthStatus {
  if (redirecting) {
    return "redirecting";
  }

  if (signingOut) {
    return "signingOut";
  }

  if (session === undefined) {
    return "loading";
  }

  if (readingSession && !isSignedIn(session)) {
    return "loading";
  }

  if (session.status === "failed") {
    return "failed";
  }

  if (session.session.user !== null) {
    return "signedIn";
  }

  return session.session.configured ? "signedOut" : "unavailable";
}

const AuthContext = createContext<Auth | null>(null);

/**
 * One sign-in state per tab, for the account menu and the Share dialog. Embeds never read it.
 *
 * The page shows at once: the session reads in the background, and the status stays `loading` until it arrives.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const { auth: authService } = useAppServices();
  const session = useFetcher<typeof loadSession>();
  const signOutFetcher = useFetcher<typeof signOut>();
  const [redirecting, setRedirecting] = useState(false);
  const readSession = session.load;
  const unread = session.state === "idle" && session.data === undefined;

  useEffect(() => {
    if (unread) {
      void readSession(SESSION_PATH);
    }
  }, [unread, readSession]);

  // Back from GitHub can show this page again from the back-forward cache, still redirecting: read the session again.
  useEffect(() => {
    if (!redirecting) {
      return;
    }

    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setRedirecting(false);
        void readSession(SESSION_PATH);
      }
    };

    window.addEventListener("pageshow", restore);

    return () => window.removeEventListener("pageshow", restore);
  }, [redirecting, readSession]);

  const status = getAuthStatus({
    redirecting,
    signingOut: signOutFetcher.state !== "idle",
    readingSession: session.state !== "idle",
    session: session.data,
  });
  useEffect(() => {
    if (status !== "signedIn" && status !== "failed") {
      return;
    }

    return followSessionActivity({
      page: { window, document },
      nowMs: Date.now,
      refresh: () => void readSession(SESSION_PATH),
    });
  }, [status, readSession]);

  const auth: Auth = {
    status,
    user: session.data?.status === "loaded" ? session.data.session.user : null,
    error: signOutFetcher.data?.status === "failed" ? signOutFetcher.data.error : "",
    signIn: () => {
      const { pathname, search, hash } = window.location;

      setRedirecting(true);
      window.location.assign(authService.getSignInUrl(`${pathname}${search}${hash}`));
    },
    signOut: () => {
      void signOutFetcher.submit(null, { method: "post", action: SESSION_PATH, defaultShouldRevalidate: false });
    },
    retry: () => {
      void readSession(SESSION_PATH);
    },
    reportSessionEnded: () => {
      void readSession(SESSION_PATH);
    },
  };

  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}

/**
 * Read the tab's sign-in
 *
 * Throws outside `AuthProvider`, which wraps every page but embeds.
 */
export function useAuth(): Auth {
  const auth = useContext(AuthContext);

  if (auth === null) {
    throw new Error("useAuth needs an AuthProvider above it. Wrap the page in <AuthProvider>.");
  }

  return auth;
}
