import { describe, expect, it } from "vitest";

import { getAuthStatus, type SessionData } from "../auth/auth-provider";
import type { AccountUser } from "../auth/contract";
import type { ProjectRecord } from "../project/projects";
import { followPage, getCloudSyncUser, getProjectChanges } from "./cloud-sync-provider";

const octocat: AccountUser = {
  githubId: 583231,
  login: "octocat",
  name: "The Octocat",
  avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
};

function makeAuth({ readingSession = false }: { readingSession?: boolean } = {}) {
  const session: SessionData = { status: "loaded", session: { configured: true, user: octocat } };
  const status = getAuthStatus({ redirecting: false, signingOut: false, readingSession, session });

  return { status, user: session.session.user };
}

describe("getCloudSyncUser", () => {
  it("should keep the signed-in account while the session reads again", () => {
    expect(getCloudSyncUser(makeAuth({ readingSession: true }), true)).toBe(octocat);
  });

  it("should wait for the local store before syncing", () => {
    expect(getCloudSyncUser(makeAuth(), false)).toBeNull();
  });
});

function makePage({ visibilityState = "visible" }: { visibilityState?: DocumentVisibilityState } = {}) {
  const document = Object.assign(new EventTarget(), { visibilityState });

  return { window: new EventTarget(), document };
}

describe("followPage", () => {
  it("should save the latest edits when the page hides and when it closes, without starting a sync", () => {
    const page = makePage();
    const sent: string[] = [];
    followPage(page, (event) => sent.push(event.type));

    page.document.visibilityState = "hidden";
    page.document.dispatchEvent(new Event("visibilitychange"));
    page.window.dispatchEvent(new Event("pagehide"));

    expect(sent).toEqual(["page.leave", "page.leave"]);
  });

  it("should sync again when the page shows, gets focus or comes back online", () => {
    const page = makePage({ visibilityState: "hidden" });
    const sent: string[] = [];
    const stop = followPage(page, (event) => sent.push(event.type));

    page.document.visibilityState = "visible";
    page.document.dispatchEvent(new Event("visibilitychange"));
    page.window.dispatchEvent(new Event("focus"));
    page.window.dispatchEvent(new Event("online"));
    stop();
    page.window.dispatchEvent(new Event("focus"));

    expect(sent).toEqual(["sync.refresh", "sync.refresh", "sync.refresh"]);
  });
});

describe("getProjectChanges", () => {
  it("should list the projects that changed, then the ones that left the workspace", () => {
    const kept = { id: "kept", revision: 1 } as ProjectRecord;
    const edited = { id: "edited", revision: 1 } as ProjectRecord;
    const removed = { id: "removed", revision: 4 } as ProjectRecord;

    expect(getProjectChanges([kept, edited, removed], [kept, { ...edited, revision: 2 }])).toEqual([
      { id: "edited", revision: 2 },
      { id: "removed", revision: null },
    ]);
  });
});
