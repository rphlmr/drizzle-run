import {
  type ActorOutcome,
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  type MachinePath,
  type MachinePathOptions,
  type ModelEvent,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, type SnapshotFrom } from "xstate";

import type { CloudCycleResult } from "./cloud-cycle";
import { cloudSyncMachine, idleDelayMs, offlineRetryMs } from "./cloud-sync-machine";
import { CloudSyncError } from "./contract";
import type { CloudSignOutResult } from "./session-contract";

const WAKE_DELAY_MS = 1_000;
const delayEvents = {
  idle: { type: "xstate.after.wake.cloudSync.idle" },
  debouncing: { type: `xstate.after.${idleDelayMs}.cloudSync.debouncing` },
  offline: { type: `xstate.after.${offlineRetryMs}.cloudSync.offline` },
} as const;
const delays = new Map<string, number>([
  [delayEvents.idle.type, WAKE_DELAY_MS],
  [delayEvents.debouncing.type, idleDelayMs],
  [delayEvents.offline.type, offlineRetryMs],
]);

function makeResult(wakeAtMs: number | undefined, projectStates: CloudCycleResult["projectStates"]): CloudCycleResult {
  return {
    status: {
      githubId: 1,
      limits: { maxProjects: 100, maxProjectBytes: 1, maxTotalBytes: 1 },
      usage: { projects: 0, bytes: 0 },
      projects: [],
    },
    projectStates,
    failures: [],
    projectBytes: new Map(),
    copies: [],
    moved: new Set(),
    wakeAtMs,
    syncedCopies: new Map(),
  };
}

const resultWithoutWake = makeResult(undefined, new Map([["p1", "synced"]]));
const resultWithWake = makeResult(0, new Map([["p1", "synced"]]));
const resultWithUnsaved = makeResult(undefined, new Map([["p1", "pending"]]));
const removeOutcome: ActorOutcome<CloudSignOutResult> = {
  outputs: [{ kind: "signed_out" }, { kind: "unsaved", projectIds: ["p1"] }],
  error: new Error("The projects could not be removed."),
};
const signOutOutcome: ActorOutcome<void> = { outputs: [undefined], error: new Error("The sign-out failed.") };
const expireOutcome: ActorOutcome<void> = { outputs: [undefined], error: new Error("Session cleanup failed.") };
const outcomes = {
  runCycle: {
    outputs: [resultWithoutWake, resultWithWake, resultWithUnsaved],
    error: new TypeError("Failed to fetch"),
  },
  leaveAccount: removeOutcome,
  expireSession: expireOutcome,
  signOut: signOutOutcome,
};
const cycleErrorCodes = ["sign_in_required", "account_changed", "cloud_sync_unavailable"] as const;

const projectId = "p1";
const signInFirstAccount = { type: "account.set", githubId: 1 } as const;
const signInOtherAccount = { type: "account.set", githubId: 2 } as const;
const startWrite = { type: "cycle.write.start", projectId } as const;
const finishWrite = { type: "cycle.write.done", projectId, revision: 3 } as const;
const changeAsWritten = { type: "projects.change", changes: [{ id: projectId, revision: 3 }] } as const;
const changeAfterWrite = { type: "projects.change", changes: [{ id: projectId, revision: 4 }] } as const;
const eventLabels = new Map<unknown, string>([
  [signInFirstAccount, "account.set"],
  [signInOtherAccount, "account.set of another account"],
  [changeAsWritten, "projects.change at the written revision"],
  [changeAfterWrite, "projects.change at a later revision"],
  [delayEvents.idle, "after the wake delay"],
  [delayEvents.debouncing, `after ${idleDelayMs} ms`],
  [delayEvents.offline, `after ${offlineRetryMs} ms`],
]);

function describeEvent(event: ModelEvent) {
  if (event.output === resultWithoutWake) {
    return "done(runCycle) without a wake";
  }

  if (event.output === resultWithWake) {
    return "done(runCycle) with a wake";
  }

  if (event.output === resultWithUnsaved) {
    return "done(runCycle) with unsaved edits";
  }

  return eventLabels.get(event);
}

type CloudSyncSnapshot = SnapshotFrom<typeof cloudSyncMachine>;

function toResultModel(result: CloudCycleResult | null) {
  if (result === null) {
    return "none";
  }

  return result.wakeAtMs === undefined ? "no_wake" : "wake";
}

function toCycleWriteModel(cycleWrites: ReadonlyMap<string, number | null>) {
  if (!cycleWrites.has(projectId)) {
    return "none";
  }

  return cycleWrites.get(projectId) === null ? "writing" : "written";
}

function toModelState(snapshot: CloudSyncSnapshot) {
  const { githubId, dirty, result, cycleWrites } = snapshot.context;
  const model = {
    value: snapshot.value,
    account: githubId,
    ...(snapshot.matches("leaving") ? { leavePolicy: snapshot.context.leavePolicy } : {}),
  };

  if (snapshot.matches("syncing")) {
    return { ...model, dirty, cycleWrite: toCycleWriteModel(cycleWrites) };
  }

  if (snapshot.matches({ leaving: "flushing" })) {
    return {
      ...model,
      edited: snapshot.context.changedIds.has(projectId),
      cycleWrite: toCycleWriteModel(cycleWrites),
    };
  }

  if (snapshot.matches("idle") || snapshot.matches("debouncing")) {
    return { ...model, result: toResultModel(result), cycleWrite: toCycleWriteModel(cycleWrites) };
  }

  return model;
}

function getCycleEvents(snapshot: CloudSyncSnapshot): ModelEvent[] {
  if (!snapshot.matches("syncing") && !snapshot.matches({ leaving: "flushing" })) {
    return getSettleEvents(snapshot, outcomes);
  }

  const cycleWrite = toCycleWriteModel(snapshot.context.cycleWrites);

  if (cycleWrite === "writing") {
    return [finishWrite];
  }

  return [...(cycleWrite === "none" ? [startWrite] : []), ...getSettleEvents(snapshot, outcomes)];
}

function getDelayEvents(snapshot: CloudSyncSnapshot): ModelEvent[] {
  const delayedStates = [
    { state: "idle", event: delayEvents.idle },
    { state: "debouncing", event: delayEvents.debouncing },
    { state: "offline", event: delayEvents.offline },
  ] as const;

  return delayedStates.filter(({ state }) => snapshot.matches(state)).map(({ event }) => event);
}

function startCloudSync(runCycleOutcome: ActorOutcome<CloudCycleResult>) {
  const settler = createActorSettler();
  const machine = cloudSyncMachine.provide({
    actions: { reportSessionEnded: vi.fn<() => void>(), saveOnLeave: vi.fn<() => void>() },
    actors: {
      runCycle: settler.fromOutcome(runCycleOutcome),
      leaveAccount: settler.fromOutcome(outcomes.leaveAccount),
      expireSession: settler.fromOutcome(outcomes.expireSession),
      signOut: settler.fromOutcome(outcomes.signOut),
    },
  });

  return { actor: createActor(machine).start(), settler };
}

const paths = getMachinePaths(cloudSyncMachine, {
  toModelState,
  describeEvent,
  events: (snapshot) => {
    if (snapshot.context.githubId === signInOtherAccount.githubId) {
      return [];
    }

    return [
      signInFirstAccount,
      signInOtherAccount,
      { type: "account.clear" },
      changeAsWritten,
      changeAfterWrite,
      { type: "project.move", projectId },
      { type: "copies.dismiss" },
      { type: "sync.refresh" },
      { type: "page.leave" },
      { type: "account.leave" },
      { type: "leave.confirm" },
      { type: "leave.retry" },
      { type: "leave.cancel" },
      ...getDelayEvents(snapshot),
      ...getCycleEvents(snapshot),
    ];
  },
});

function describePaths(
  name: string,
  machinePaths: readonly MachinePath[],
  runCycleOutcome: ActorOutcome<CloudCycleResult>,
) {
  describe(`${name} paths`, () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should take the same transitions", () => {
      expect(toTransitionTable(machinePaths)).toMatchSnapshot();
    });

    for (const path of machinePaths) {
      it(`should take ${path.description}`, async () => {
        const { actor, settler } = startCloudSync(runCycleOutcome);

        await expect(
          replayMachinePath(path, {
            actor,
            settler,
            toModelState,
            advance: (event) => advanceTimers(delays.get(event.type) ?? 0),
            flush: () => advanceTimers(0),
          }),
        ).resolves.toBeUndefined();
        actor.stop();
      });
    }
  });
}

async function advanceTimers(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("cloud sync machine paths", () => {
  describePaths("every transition", paths, outcomes.runCycle);

  for (const code of cycleErrorCodes) {
    const runCycleOutcome: ActorOutcome<CloudCycleResult> = {
      outputs: [],
      error: new CloudSyncError(code, `The cycle stopped: ${code}`),
    };
    const errorOutcomes = { runCycle: runCycleOutcome, expireSession: outcomes.expireSession };
    const options: MachinePathOptions = {
      toModelState,
      describeEvent: (event) => (event.type.startsWith("xstate.error.actor.") ? `error(runCycle) ${code}` : undefined),
      events: (snapshot) => [signInFirstAccount, ...getSettleEvents(snapshot, errorOutcomes)],
    };

    describePaths(`a cycle that fails with ${code}`, getMachinePaths(cloudSyncMachine, options), runCycleOutcome);
  }
});
