import { describe, expect, it } from "vitest";
import { createActor, fromPromise, SimulatedClock, waitFor } from "xstate";

import type { CloudCycleResult, ProjectSyncState } from "./cloud-cycle";
import {
  cloudSyncMachine,
  idleDelayMs,
  type CloudLeaveSave,
  type CloudSyncAccount,
  type CloudSyncCycleInput,
} from "./cloud-sync-machine";
import { CloudSyncError } from "./contract";
import type { CloudSignOutInput } from "./session-contract";

function makeResult(overrides: Partial<CloudCycleResult> = {}): CloudCycleResult {
  return {
    status: {
      githubId: 1,
      limits: { maxProjects: 100, maxProjectBytes: 1, maxTotalBytes: 1 },
      usage: { projects: 0, bytes: 0 },
      projects: [],
    },
    projectStates: new Map(),
    failures: [],
    projectBytes: new Map(),
    copies: [],
    moved: new Set(),
    wakeAtMs: undefined,
    syncedCopies: new Map(),
    ...overrides,
  };
}

function makeStates(states: Record<string, ProjectSyncState>): ReadonlyMap<string, ProjectSyncState> {
  return new Map(Object.entries(states));
}

function startMachine({
  cycle = async (_input: CloudSyncCycleInput) => makeResult(),
  removeCloudProjects = async (_account: CloudSyncAccount) => {},
  unsavedAtRemoval = [] as string[],
  expireSession = async (_githubId: number | null) => {},
} = {}) {
  const clock = new SimulatedClock();
  const cycles: CloudSyncCycleInput[] = [];
  const endedSessions: number[] = [];
  const leaveSaves: CloudLeaveSave[] = [];
  const removed: CloudSyncAccount[] = [];
  const signOuts: number[] = [];
  const expired: (number | null)[] = [];
  const actor = createActor(
    cloudSyncMachine.provide({
      actions: {
        reportSessionEnded: () => {
          endedSessions.push(Date.now());
        },
        saveOnLeave: (_, save) => {
          leaveSaves.push(save);
        },
      },
      actors: {
        runCycle: fromPromise(async ({ input }: { input: CloudSyncCycleInput }) => {
          cycles.push(input);
          return cycle(input);
        }),
        leaveAccount: fromPromise(async ({ input }: { input: CloudSignOutInput }) => {
          if (input.policy === "require_saved" && unsavedAtRemoval.length > 0) {
            return { kind: "unsaved" as const, projectIds: unsavedAtRemoval };
          }

          await removeCloudProjects(input);
          removed.push({ githubId: input.githubId });
          signOuts.push(Date.now());

          return { kind: "signed_out" as const };
        }),
        expireSession: fromPromise(async ({ input }) => {
          await expireSession(input.githubId);
          expired.push(input.githubId);
        }),
        signOut: fromPromise(async () => {
          signOuts.push(Date.now());
        }),
      },
    }),
    { clock },
  );
  actor.start();

  return { actor, clock, cycles, endedSessions, leaveSaves, removed, signOuts, expired };
}

describe("cloudSyncMachine", () => {
  it("should sync right after sign-in, with no question, and wait for a pause in editing", async () => {
    const { actor, clock, cycles } = startMachine();

    actor.send({ type: "account.set", githubId: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));
    actor.send({ type: "projects.change", changes: [{ id: "p", revision: 2 }] });
    clock.increment(idleDelayMs - 1);
    actor.send({ type: "projects.change", changes: [{ id: "p", revision: 2 }] });
    clock.increment(idleDelayMs - 1);

    expect(actor.getSnapshot().matches("debouncing")).toBe(true);

    clock.increment(1);
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    expect(cycles).toHaveLength(2);
  });

  it("should sync after a project left the workspace, so a delete reaches the account", async () => {
    const { actor } = startMachine();
    actor.send({ type: "account.set", githubId: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    actor.send({ type: "projects.change", changes: [{ id: "p", revision: null }] });

    expect(actor.getSnapshot().matches("debouncing")).toBe(true);
  });

  it("should not schedule another cycle for the projects the cycle itself wrote", async () => {
    let cycleCount = 0;
    const { actor } = startMachine({
      cycle: async (input) => {
        cycleCount += 1;

        if (cycleCount === 2) {
          input.reportWrite({ type: "cycle.write.start", projectId: "downloaded" });
          actor.send({ type: "projects.change", changes: [{ id: "downloaded", revision: 3 }] });
          input.reportWrite({ type: "cycle.write.done", projectId: "downloaded", revision: 3 });
          actor.send({ type: "projects.change", changes: [{ id: "downloaded", revision: 3 }] });
          input.reportWrite({ type: "cycle.write.start", projectId: "discarded" });
          input.reportWrite({ type: "cycle.write.done", projectId: "discarded", revision: null });
          actor.send({ type: "projects.change", changes: [{ id: "discarded", revision: null }] });
        }

        return makeResult();
      },
    });
    actor.send({ type: "account.set", githubId: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    actor.send({ type: "sync.refresh" });
    await waitFor(actor, (snapshot) => snapshot.matches("idle") && cycleCount === 2);

    expect(actor.getSnapshot().context.changedIds.size).toBe(0);
    actor.send({ type: "projects.change", changes: [{ id: "downloaded", revision: 3 }] });
    expect(actor.getSnapshot().matches("idle")).toBe(true);
    actor.send({ type: "projects.change", changes: [{ id: "downloaded", revision: 4 }] });
    expect(actor.getSnapshot().matches("debouncing")).toBe(true);
  });

  it("should save the projects edited since the last cycle when the page closes during the edit pause", async () => {
    const { actor, leaveSaves } = startMachine();
    actor.send({ type: "account.set", githubId: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    actor.send({ type: "page.leave" });
    actor.send({ type: "projects.change", changes: [{ id: "a", revision: 2 }] });
    actor.send({ type: "projects.change", changes: [{ id: "b", revision: 5 }] });
    actor.send({ type: "page.leave" });

    expect(leaveSaves.map((save) => [...save.changedIds])).toEqual([["a", "b"]]);
  });

  it("should save each edit once when the page hides and then closes", async () => {
    const { actor, leaveSaves } = startMachine();
    actor.send({ type: "account.set", githubId: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    actor.send({ type: "projects.change", changes: [{ id: "a", revision: 2 }] });
    actor.send({ type: "page.leave" });
    actor.send({ type: "page.leave" });
    actor.send({ type: "projects.change", changes: [{ id: "b", revision: 5 }] });
    actor.send({ type: "page.leave" });

    expect(leaveSaves.map((save) => [...save.changedIds])).toEqual([["a"], ["b"]]);
  });

  it("should forget the edits a cycle starts with, and keep the ones made while it runs", async () => {
    let finishCycle: (() => void) | undefined;
    const { actor, clock, cycles } = startMachine({
      cycle: () =>
        new Promise((resolve) => {
          finishCycle = () => resolve(makeResult());
        }),
    });
    actor.send({ type: "account.set", githubId: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches("syncing"));
    finishCycle?.();
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));
    actor.send({ type: "projects.change", changes: [{ id: "before", revision: 2 }] });
    clock.increment(idleDelayMs);
    await waitFor(actor, (snapshot) => snapshot.matches("syncing") && cycles.length === 2);

    actor.send({ type: "projects.change", changes: [{ id: "during", revision: 2 }] });
    finishCycle?.();
    await waitFor(actor, (snapshot) => snapshot.matches("debouncing"));

    expect([...actor.getSnapshot().context.changedIds]).toEqual(["during"]);
  });

  it("should send a move to Cloud with the next cycle and drop it once applied", async () => {
    const { actor, cycles } = startMachine({
      cycle: async (input) => makeResult({ moved: new Set(input.moves) }),
    });
    actor.send({ type: "account.set", githubId: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    actor.send({ type: "project.move", projectId: "p" });
    await waitFor(actor, (snapshot) => snapshot.matches("idle") && cycles.length === 2);

    expect([...(cycles[1]?.moves ?? [])]).toEqual(["p"]);
    expect(actor.getSnapshot().context.moves.size).toBe(0);
  });

  it("should keep the copies a conflict added until the notice is dismissed", async () => {
    const copy = { projectId: "p", copyId: "c", name: "Users", copyName: "Users (copy)" };
    const { actor, cycles } = startMachine({
      cycle: async () => makeResult({ copies: cycles.length === 1 ? [copy] : [] }),
    });
    actor.send({ type: "account.set", githubId: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));
    actor.send({ type: "sync.refresh" });
    await waitFor(actor, (snapshot) => snapshot.matches("idle") && cycles.length === 2);

    expect(actor.getSnapshot().context.copies).toEqual([copy]);

    actor.send({ type: "copies.dismiss" });

    expect(actor.getSnapshot().context.copies).toEqual([]);
  });

  it("should go offline on a network failure, and stop when the session ended", async () => {
    let fail: Error = new TypeError("Failed to fetch");
    const { actor } = startMachine({
      cycle: async () => {
        throw fail;
      },
    });

    actor.send({ type: "account.set", githubId: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches("offline"));
    fail = new CloudSyncError("sign_in_required", "Sign in");
    actor.send({ type: "sync.refresh" });
    await waitFor(actor, (snapshot) => snapshot.matches("signedOut"));

    expect(actor.getSnapshot().context.result).toBeNull();
  });

  it("should report a session the Worker refused, so the tab offers to sign in again", async () => {
    const { actor, endedSessions, expired } = startMachine({
      cycle: async () => {
        throw new CloudSyncError("sign_in_required", "Sign in with GitHub.");
      },
    });

    actor.send({ type: "account.set", githubId: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches("signedOut"));

    expect(endedSessions).toHaveLength(1);
    expect(expired).toEqual([1]);
  });

  it("should clean up persisted Cloud projects when a reload finds an already expired session", async () => {
    const { actor, expired } = startMachine();

    actor.send({ type: "account.clear" });
    await waitFor(actor, (snapshot) => snapshot.matches("signedOut"));

    expect(expired).toEqual([null]);
    actor.stop();
  });

  it("should retain the account for retry when session cleanup fails", async () => {
    let failCleanup = true;
    const { actor, expired } = startMachine({
      expireSession: async () => {
        if (failCleanup) {
          throw new Error("The store is busy.");
        }
      },
    });
    actor.send({ type: "account.set", githubId: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    actor.send({ type: "account.clear" });
    await waitFor(actor, (snapshot) => snapshot.matches("sessionFailed"));
    expect(actor.getSnapshot().context.githubId).toBe(1);

    failCleanup = false;
    actor.send({ type: "sync.refresh" });
    await waitFor(actor, (snapshot) => snapshot.matches("signedOut"));
    expect(expired).toEqual([1]);
    actor.stop();
  });

  it("should sync again when a session read finds the same account after the Worker refused the session", async () => {
    let refuse = true;
    const { actor, cycles } = startMachine({
      cycle: async () => {
        if (refuse) {
          throw new CloudSyncError("sign_in_required", "Sign in with GitHub.");
        }

        return makeResult();
      },
    });
    actor.send({ type: "account.set", githubId: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches("signedOut"));
    refuse = false;

    actor.send({ type: "account.set", githubId: 1 });

    await waitFor(actor, (snapshot) => snapshot.matches("idle"));
    expect(cycles).toHaveLength(2);
  });

  it("should start over for another account, without carrying the first one's changes", async () => {
    const { actor, cycles } = startMachine();
    actor.send({ type: "account.set", githubId: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));
    actor.send({ type: "account.set", githubId: 1 });

    actor.send({ type: "account.set", githubId: 2 });

    expect(actor.getSnapshot().context).toMatchObject({ githubId: 2, result: null });
    await waitFor(actor, (snapshot) => snapshot.matches("idle") && cycles.length === 2);
    expect(cycles.map((input) => input.githubId)).toEqual([1, 2]);
  });

  it("should stop and say why when another tab signed in as someone else", async () => {
    const { actor } = startMachine({
      cycle: async () => {
        throw new CloudSyncError("account_changed", "Reload the page.");
      },
    });

    actor.send({ type: "account.set", githubId: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches("signedOut"));

    expect(actor.getSnapshot().context).toMatchObject({ githubId: null, error: "Reload the page." });
  });
});

describe("cloudSyncMachine sign-out", () => {
  it("should ask first, and keep syncing when the sign-out is cancelled", async () => {
    const { actor, cycles, removed, signOuts } = startMachine();
    actor.send({ type: "account.set", githubId: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    actor.send({ type: "account.leave" });

    expect(actor.getSnapshot().matches({ leaving: "asking" })).toBe(true);

    actor.send({ type: "leave.cancel" });
    await waitFor(actor, (snapshot) => snapshot.matches("idle") && cycles.length === 2);

    expect(removed).toEqual([]);
    expect(signOuts).toEqual([]);
  });

  it("should save once more, then remove every Cloud project, then sign out", async () => {
    const { actor, cycles, removed, signOuts } = startMachine({
      cycle: async () => makeResult({ projectStates: makeStates({ a: "synced", c: "local" }) }),
    });
    actor.send({ type: "account.set", githubId: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    actor.send({ type: "account.leave" });
    actor.send({ type: "leave.confirm" });
    await waitFor(actor, (snapshot) => snapshot.matches("signedOut"));

    expect(cycles).toHaveLength(2);
    expect(removed).toEqual([{ githubId: 1 }]);
    expect(signOuts).toHaveLength(1);
    expect(actor.getSnapshot().context.githubId).toBeNull();
  });

  it("should stop on edits the account lacks, and remove the Cloud projects only once the owner signs out anyway", async () => {
    const { actor, removed, signOuts } = startMachine({
      cycle: async () => makeResult({ projectStates: makeStates({ a: "synced", b: "pending", c: "too_large" }) }),
    });
    actor.send({ type: "account.set", githubId: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    actor.send({ type: "account.leave" });
    actor.send({ type: "leave.confirm" });
    await waitFor(actor, (snapshot) => snapshot.matches({ leaving: "unsaved" }));

    expect(removed).toEqual([]);

    actor.send({ type: "leave.confirm" });
    await waitFor(actor, (snapshot) => snapshot.matches("signedOut"));

    expect(removed).toEqual([{ githubId: 1 }]);
    expect(signOuts).toHaveLength(1);
  });

  it("should warn when a Cloud project changes during the final save even if its cycle reports synced", async () => {
    const { actor, cycles, removed, signOuts } = startMachine({
      cycle: async () => {
        if (cycles.length === 2) {
          actor.send({ type: "projects.change", changes: [{ id: "a", revision: 2 }] });
        }

        return makeResult({ projectStates: makeStates({ a: "synced", local: "local" }) });
      },
    });
    actor.send({ type: "account.set", githubId: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    actor.send({ type: "account.leave" });
    actor.send({ type: "leave.confirm" });
    const result = await waitFor(
      actor,
      (snapshot) => snapshot.matches({ leaving: "unsaved" }) || snapshot.matches("signedOut"),
    );

    expect(result.matches({ leaving: "unsaved" })).toBe(true);
    expect(result.context.result?.projectStates.get("a")).toBe("pending");
    expect(removed).toEqual([]);
    expect(signOuts).toEqual([]);
    actor.stop();
  });

  it("should save again on retry and sign out once every edit reached the account", async () => {
    let offline = true;
    const { actor, cycles, removed, signOuts } = startMachine({
      cycle: async () => {
        if (cycles.length > 1 && offline) {
          throw new TypeError("Failed to fetch");
        }

        return makeResult({ projectStates: makeStates({ a: "synced" }) });
      },
    });
    actor.send({ type: "account.set", githubId: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    actor.send({ type: "account.leave" });
    actor.send({ type: "leave.confirm" });
    await waitFor(actor, (snapshot) => snapshot.matches({ leaving: "unsaved" }));

    expect(actor.getSnapshot().context.error).toBe("Failed to fetch");

    offline = false;
    actor.send({ type: "leave.retry" });
    await waitFor(actor, (snapshot) => snapshot.matches("signedOut"));

    expect(cycles).toHaveLength(3);
    expect(removed).toEqual([{ githubId: 1 }]);
    expect(signOuts).toHaveLength(1);
  });

  it("should allow retry or cancellation when the Cloud projects could not leave this browser", async () => {
    const { actor, signOuts } = startMachine({
      removeCloudProjects: async () => {
        throw new Error("The store is busy.");
      },
    });
    actor.send({ type: "account.set", githubId: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    actor.send({ type: "account.leave" });
    actor.send({ type: "leave.confirm" });
    const afterFailure = await waitFor(actor, (snapshot) => snapshot.context.error === "The store is busy.");

    expect(afterFailure.matches({ leaving: "unsaved" })).toBe(true);
    expect(afterFailure.context.githubId).toBe(1);
    expect(signOuts).toEqual([]);
  });

  it("should warn about edits found by the final locked store check and require explicit confirmation", async () => {
    const { actor, removed, signOuts } = startMachine({ unsavedAtRemoval: ["late-edit"] });
    actor.send({ type: "account.set", githubId: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    actor.send({ type: "account.leave" });
    actor.send({ type: "leave.confirm" });
    await waitFor(actor, (snapshot) => snapshot.matches({ leaving: "unsaved" }));

    expect(actor.getSnapshot().context.leaveUnsavedIds).toEqual(["late-edit"]);
    expect(removed).toEqual([]);
    expect(signOuts).toEqual([]);

    actor.send({ type: "leave.confirm" });
    await waitFor(actor, (snapshot) => snapshot.matches("signedOut"));
    expect(signOuts).toHaveLength(1);
    actor.stop();
  });

  it("should sign out straight away when no account syncs in this tab", async () => {
    const { actor, removed, signOuts } = startMachine();

    actor.send({ type: "account.leave" });
    await waitFor(actor, () => signOuts.length === 1);

    expect(removed).toEqual([]);
    expect(actor.getSnapshot().matches("signedOut")).toBe(true);
  });
});
