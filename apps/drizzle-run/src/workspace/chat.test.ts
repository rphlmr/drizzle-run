import type { ChatProject } from "@drizzle-run/core/connect";
import { describe, expect, it, vi } from "vitest";

import type { ConnectViewOptions } from "../connect/connect-provider";
import { createProject } from "../project/projects";
import { getChatTarget, isWorkspaceChat, toChatProject, toConnectHost, type ViewConnectHost } from "./chat";

const sides = [
  { side: 0, name: "0.45", orm: "0.45.2" },
  { side: 1, name: "rc.5", orm: "1.0.0-rc.5" },
] as const satisfies ChatProject["sides"];

function readNoGuide() {
  return undefined;
}

function makeConnect(options: Partial<ConnectViewOptions> = {}): ConnectViewOptions {
  return { scope: "project", conversation: "project:p1", ...options };
}

function makeChatTarget(options: { connect?: ConnectViewOptions; shown?: boolean } = {}) {
  return getChatTarget({
    connect: options.connect ?? makeConnect(),
    project: { id: "p1", name: "Blog" },
    files: ["schema.ts", "query.ts"],
    shown: options.shown ?? true,
  });
}

function makeViewHost(): ViewConnectHost {
  const project = createProject("Blog", { dialect: "sqlite" });

  return {
    project: () => project,
    save: vi.fn(),
    problems: () => [],
    latestRun: () => undefined,
    run: () => Promise.resolve(),
    running: () => false,
  };
}

describe("toChatProject", () => {
  it("should name a user's own one-version project without origin or sides", () => {
    const project = createProject("Blog", { dialect: "sqlite" });

    expect(toChatProject(project)).toEqual({ id: project.id, name: "Blog" });
  });

  it("should keep a Community project's origin and name both sides", () => {
    const project = { ...createProject("Shared", { dialect: "postgresql" }), origin: "community" as const };

    expect(toChatProject(project, sides)).toEqual({ id: project.id, name: "Shared", origin: "community", sides });
  });
});

describe("isWorkspaceChat", () => {
  it("should hold for a workspace project, trusted or not", () => {
    expect(isWorkspaceChat(makeConnect())).toBe(true);
    expect(isWorkspaceChat(makeConnect({ scope: "untrusted" }))).toBe(true);
  });

  it("should not hold for a guide, a shared link, or no chat", () => {
    expect(isWorkspaceChat(makeConnect({ scope: "guide" }))).toBe(false);
    expect(isWorkspaceChat(makeConnect({ scope: "snapshot" }))).toBe(false);
    expect(isWorkspaceChat(undefined)).toBe(false);
  });
});

describe("getChatTarget", () => {
  it("should have no dock without a conversation or while the view has no room", () => {
    expect(makeChatTarget({ connect: makeConnect({ conversation: undefined }) })).toBeUndefined();
    expect(makeChatTarget({ shown: false })).toBeUndefined();
  });

  it("should point the dock at the project's conversation and files", () => {
    expect(makeChatTarget()).toEqual({
      conversation: "project:p1",
      project: { id: "p1", name: "Blog" },
      files: ["schema.ts", "query.ts"],
      scope: "project",
    });
  });

  it("should ask for trust from an untrusted project's dock", () => {
    const requestTrust = vi.fn();
    const target = makeChatTarget({
      connect: makeConnect({ scope: "untrusted", trust: { state: "untrusted", requestTrust, untrust: vi.fn() } }),
    });

    expect(target?.onTrust).toBe(requestTrust);
  });

  it("should say a guide's place, or the project's name without one", () => {
    const placed = makeChatTarget({ connect: makeConnect({ scope: "guide", position: "Step 2 of 3 · Blog" }) });
    const unplaced = makeChatTarget({ connect: makeConnect({ scope: "guide" }) });

    expect(placed?.guided).toEqual({ position: "Step 2 of 3 · Blog" });
    expect(unplaced?.guided).toEqual({ position: "Blog" });
  });
});

describe("toConnectHost", () => {
  it("should lend the view's calls with its scope, guide and Query plans flag", () => {
    const view = makeViewHost();
    const queryPlans = { get: vi.fn(), set: vi.fn() };
    const host = toConnectHost(makeConnect({ scope: "guide", guide: readNoGuide }), view, queryPlans);

    expect(host).toEqual({ ...view, scope: "guide", guide: readNoGuide, queryPlans });
    expect(host).not.toHaveProperty("fork");
  });

  it("should lend a shared link's fork", () => {
    const fork = vi.fn();

    expect(toConnectHost(makeConnect({ scope: "snapshot", fork }), makeViewHost(), undefined).fork).toBe(fork);
  });
});
