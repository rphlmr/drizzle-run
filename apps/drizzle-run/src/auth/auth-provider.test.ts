import { describe, expect, it } from "vitest";

import { getAuthStatus, type SessionData } from "./auth-provider";
import type { AccountUser } from "./contract";

const octocat: AccountUser = {
  githubId: 583231,
  login: "octocat",
  name: "The Octocat",
  avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
};

function makeStatusInput({
  redirecting = false,
  signingOut = false,
  readingSession = false,
  session = { status: "loaded", session: { configured: true, user: null } },
}: {
  redirecting?: boolean;
  signingOut?: boolean;
  readingSession?: boolean;
  session?: SessionData;
} = {}) {
  return { redirecting, signingOut, readingSession, session };
}

describe("getAuthStatus", () => {
  it("should be loading before the session is read", () => {
    expect(getAuthStatus({ ...makeStatusInput(), session: undefined })).toBe("loading");
  });

  it("should stay signed in while the session reads again", () => {
    const session: SessionData = { status: "loaded", session: { configured: true, user: octocat } };

    expect(getAuthStatus(makeStatusInput({ readingSession: true, session }))).toBe("signedIn");
  });

  it("should be loading while the session reads again without an account read before", () => {
    expect(getAuthStatus(makeStatusInput({ readingSession: true }))).toBe("loading");
  });

  it("should tell signed in, signed out and no sign-in on this deployment apart", () => {
    expect(
      getAuthStatus(makeStatusInput({ session: { status: "loaded", session: { configured: true, user: octocat } } })),
    ).toBe("signedIn");
    expect(getAuthStatus(makeStatusInput())).toBe("signedOut");
    expect(
      getAuthStatus(makeStatusInput({ session: { status: "loaded", session: { configured: false, user: null } } })),
    ).toBe("unavailable");
  });

  it("should be failed when the session could not be read", () => {
    expect(getAuthStatus(makeStatusInput({ session: { status: "failed", error: "Offline" } }))).toBe("failed");
  });

  it("should stay signing out while the session reads again after the sign-out", () => {
    expect(getAuthStatus(makeStatusInput({ signingOut: true, readingSession: true }))).toBe("signingOut");
  });

  it("should stay redirecting until the page leaves for GitHub", () => {
    expect(getAuthStatus(makeStatusInput({ redirecting: true }))).toBe("redirecting");
  });
});
