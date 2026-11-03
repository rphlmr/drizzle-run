import { assign, fromPromise, setup } from "xstate";

import { declareType } from "../lib/declare-type";
import { getErrorText } from "../lib/error-text";
import type { CloudConflictCopy, CloudCycleInput, CloudCycleResult, ProjectSyncState } from "./cloud-cycle";
import { CloudSyncError } from "./contract";
import type { CloudSignOutInput, CloudSignOutResult } from "./session-contract";

/** The signed-in GitHub account, by its numeric id: every sync row belongs to it. */
export interface CloudSyncAccount {
  githubId: number;
}

/** The tab's sign-in, as cloud sync hears it. */
export type CloudSyncAccountEvent = { type: "account.set"; githubId: number } | { type: "account.clear" };

/** A workspace project that changed, at the revision it changed to; null when it left the workspace. */
export interface CloudProjectChange {
  id: string;
  revision: number | null;
}

/** The cycle's own writes into the workspace, reported before and after each one. */
export type CloudCycleWriteEvent =
  | { type: "cycle.write.start"; projectId: string }
  | { type: "cycle.write.done"; projectId: string; revision: number | null };

type CloudSyncEvent =
  | CloudSyncAccountEvent
  | CloudCycleWriteEvent
  | { type: "projects.change"; changes: readonly CloudProjectChange[] }
  | { type: "project.move"; projectId: string }
  | { type: "copies.dismiss" }
  | { type: "sync.refresh" }
  | { type: "page.leave" }
  | { type: "account.leave" }
  | { type: "leave.confirm" }
  | { type: "leave.retry" }
  | { type: "leave.cancel" };

/** States of a Cloud project whose latest edits the account does not hold. */
const unsavedStates: ReadonlySet<ProjectSyncState> = new Set(["pending", "failed", "too_large", "limit"]);

/** The Cloud projects whose latest edits the account does not hold: signing out anyway loses those edits. */
export function getUnsavedProjectIds(result: CloudCycleResult | null): string[] {
  return [...(result?.projectStates ?? [])].filter(([, state]) => unsavedStates.has(state)).map(([id]) => id);
}

/** What a cycle starts from, and where it reports the projects it writes into the workspace. */
export interface CloudSyncCycleInput extends CloudCycleInput {
  reportWrite: (event: CloudCycleWriteEvent) => void;
}

/** The projects edited here since the last leave save or cycle start, for a save as the page hides or closes. */
export interface CloudLeaveSave {
  changedIds: ReadonlySet<string>;
  result: CloudCycleResult;
}

/** The machine's context: the account, pending changes, and the last cycle's result. */
export interface CloudSyncContext {
  /** The signed-in GitHub account; null while signed out. Every sync row belongs to it. */
  githubId: number | null;
  /** Projects moved to Cloud and not yet written by a cycle. */
  moves: ReadonlySet<string>;
  result: CloudCycleResult | null;
  /** The other machine's versions added as new projects since the notice was last dismissed. */
  copies: readonly CloudConflictCopy[];
  /** Projects edited here since the last leave save or cycle start. */
  changedIds: ReadonlySet<string>;
  /** Projects the running cycle writes into the workspace: null while the write runs, then the revision it stored. */
  cycleWrites: ReadonlyMap<string, number | null>;
  /** Something changed while a cycle ran, so another follows. */
  dirty: boolean;
  /** Why the last cycle stopped: offline, unavailable, or signed in elsewhere. Empty after a cycle that ran. */
  error: string;
  /** Only explicit confirmation of the unsaved warning permits discarding edits. */
  leavePolicy: CloudSignOutInput["policy"];
  /** Unsaved edits found by the final save or the locked removal check. */
  leaveUnsavedIds: readonly string[];
}

/** Waits after the last edit before a cycle: saves go on pauses, not keystrokes. */
export const idleDelayMs = 5_000;
/** Retries after a network failure. */
export const offlineRetryMs = 60_000;

const initialContext: CloudSyncContext = {
  githubId: null,
  moves: new Set(),
  result: null,
  copies: [],
  changedIds: new Set(),
  cycleWrites: new Map(),
  dirty: false,
  error: "",
  leavePolicy: "require_saved",
  leaveUnsavedIds: [],
};

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof CloudSyncError && error.code === code;
}

function getResult(context: CloudSyncContext): CloudCycleResult {
  if (context.result === null) {
    throw new Error("Expected a cycle result before a save on leave, but got none.");
  }

  return context.result;
}

/** The account the machine signed in as; the machine only invokes these actors while signed in. */
function getAccount(context: CloudSyncContext): CloudSyncAccount {
  if (context.githubId === null) {
    throw new Error("Expected a signed-in GitHub account while cloud sync runs, but got none.");
  }

  return { githubId: context.githubId };
}

/** The changes the user made, leaving out the cycle's own writes into the workspace. */
function getEditedIds(context: CloudSyncContext, changes: readonly CloudProjectChange[]): string[] {
  return changes
    .filter((change) => {
      if (!context.cycleWrites.has(change.id)) {
        return true;
      }

      const written = context.cycleWrites.get(change.id);

      return written !== null && written !== change.revision;
    })
    .map((change) => change.id);
}

/** When the next cycle should run by itself: a held-back save. Undefined when nothing waits. */
function getWakeAtMs(result: CloudCycleResult | null): number | undefined {
  return result?.wakeAtMs;
}

function getCycleInput(context: CloudSyncContext, send: (event: CloudCycleWriteEvent) => void): CloudSyncCycleInput {
  return { ...getAccount(context), moves: context.moves, reportWrite: send };
}

/** A final save cannot clear edits heard after its snapshot, even when that snapshot reached the account. */
function getLeaveResult(context: CloudSyncContext, result: CloudCycleResult): CloudCycleResult {
  const projectStates = new Map(result.projectStates);

  for (const id of context.changedIds) {
    if (projectStates.get(id) === "synced") {
      projectStates.set(id, "pending");
    }
  }

  return { ...result, projectStates };
}

/**
 * Cloud sync of the workspace's Cloud projects while signed in
 *
 * ```text
 * signedOut ─account.set─► syncing ─► settled ─► idle ─projects.change─► debouncing ─5 s─► syncing
 *                                            └► debouncing (changed during the cycle)
 *                                  idle ─(wake: held-back save, sync.refresh, project.move)─► syncing
 *                          syncing ├► offline ─60 s or sync.refresh─► syncing
 *                                  ├► unavailable               (no cloud bucket on this deployment)
 *                                  └► endingSession ─► signedOut (saved copies leave; unsaved edits become Local)
 * signed in ─account.leave─► leaving.asking ─leave.confirm─► flushing ─► removing ─► signedOut
 *                                     └leave.cancel─► syncing        └► unsaved (edits the account lacks)
 *                                                                       ─leave.retry─► flushing
 *                                                                       ─leave.confirm─► removing
 *                                                                       └leave.cancel─► syncing
 * signedOut | unavailable ─account.leave─► leaving.signingOut (no Cloud project here)
 * any ─account.clear─► endingSession ─► signedOut (or sessionFailed, retried by sync.refresh)
 * any ─account.set (another account)─► syncing, with nothing kept from the previous account
 * debouncing ─page.leave─► saveOnLeave (the projects edited since the last leave or cycle start)
 * ```
 *
 * A change counts only for the projects the user edited: the cycle reports each project it writes into the workspace,
 * and the change that write makes never schedules another cycle.
 *
 * Sign-out asks first and saves once more. Then every Cloud project leaves this browser with its row, so it comes back
 * on the next sign-in and nobody else using this browser sees it. When some edits did not reach the account, it waits
 * for the owner to try again or to sign out anyway and lose them. Local projects stay. A project
 * that fails on its own is part of the cycle's result, not an error here. The local store stays the source of truth:
 * nothing here blocks or replaces local saves.
 */
export const cloudSyncMachine = setup({
  types: {
    context: declareType<CloudSyncContext>(),
    events: declareType<CloudSyncEvent>(),
  },
  actors: {
    leaveAccount: fromPromise<CloudSignOutResult, CloudSignOutInput>(async () => {
      throw new Error("leaveAccount is provided by the workspace");
    }),
    expireSession: fromPromise<void, { githubId: number | null }>(async () => {
      throw new Error("expireSession is provided by the workspace");
    }),
    signOut: fromPromise<void>(async () => {
      throw new Error("signOut is provided by the workspace");
    }),
    runCycle: fromPromise<CloudCycleResult, CloudSyncCycleInput>(async () => {
      throw new Error("runCycle is provided by the workspace");
    }),
  },
  delays: {
    wake: ({ context }) => Math.max(1_000, (getWakeAtMs(context.result) ?? Date.now()) - Date.now()),
  },
  guards: {
    hasWake: ({ context }) => getWakeAtMs(context.result) !== undefined,
    isDirty: ({ context }) => context.dirty,
    isSignedIn: ({ context }) => context.githubId !== null,
    hasUnsavedProjects: (_, result: CloudCycleResult) => getUnsavedProjectIds(result).length > 0,
    isOtherAccount: ({ context }, githubId: number) => context.githubId !== githubId,
    hasLeaveSave: ({ context }) => context.result !== null && context.changedIds.size > 0,
    hasEdits: ({ context }, changes: readonly CloudProjectChange[]) => getEditedIds(context, changes).length > 0,
  },
  actions: {
    reportSessionEnded: () => {},
    saveOnLeave: (_action, _save: CloudLeaveSave) => {},
    recordEdits: assign(({ context }, changes: readonly CloudProjectChange[]) => ({
      changedIds: new Set([...context.changedIds, ...getEditedIds(context, changes)]),
    })),
    recordWrite: assign(({ context }, event: CloudCycleWriteEvent) => ({
      cycleWrites: new Map([
        ...context.cycleWrites,
        [event.projectId, event.type === "cycle.write.done" ? event.revision : null],
      ]),
    })),
    move: assign(({ context }, params: { projectId: string }) => ({
      moves: new Set([...context.moves, params.projectId]),
    })),
    // Drop the moves the cycle applied; keep ones that changed meanwhile.
    applyResult: assign(({ context }, result: CloudCycleResult) => ({
      result,
      error: "",
      copies: [...context.copies, ...result.copies],
      moves: new Set([...context.moves].filter((id) => !result.moved.has(id))),
    })),
  },
}).createMachine({
  id: "cloudSync",
  initial: "signedOut",
  context: initialContext,
  on: {
    "account.clear": { target: ".endingSession" },
    "account.set": {
      guard: { type: "isOtherAccount", params: ({ event }) => event.githubId },
      target: ".syncing",
      reenter: true,
      actions: assign(({ event }) => ({ ...initialContext, githubId: event.githubId })),
    },
    "account.leave": [{ guard: "isSignedIn", target: ".leaving" }, { target: ".leaving.signingOut" }],
    "copies.dismiss": { actions: assign({ copies: [] }) },
  },
  states: {
    signedOut: {
      on: { "account.leave": "leaving.signingOut" },
    },
    endingSession: {
      on: { "account.clear": {}, "account.leave": {} },
      invoke: {
        src: "expireSession",
        input: ({ context }) => ({ githubId: context.githubId }),
        onDone: {
          target: "signedOut",
          actions: assign(({ context }) => ({ ...initialContext, error: context.error })),
        },
        onError: {
          target: "sessionFailed",
          actions: assign({ error: ({ event }) => getErrorText(event.error) }),
        },
      },
    },
    sessionFailed: {
      on: { "account.clear": {}, "sync.refresh": "endingSession" },
    },
    idle: {
      after: {
        wake: { guard: "hasWake", target: "syncing" },
      },
      on: {
        "projects.change": {
          guard: { type: "hasEdits", params: ({ event }) => event.changes },
          target: "debouncing",
          actions: { type: "recordEdits", params: ({ event }) => event.changes },
        },
        "sync.refresh": "syncing",
        "project.move": { target: "syncing", actions: { type: "move", params: ({ event }) => event } },
      },
    },
    debouncing: {
      after: { [idleDelayMs]: "syncing" },
      on: {
        "projects.change": {
          guard: { type: "hasEdits", params: ({ event }) => event.changes },
          target: "debouncing",
          reenter: true,
          actions: { type: "recordEdits", params: ({ event }) => event.changes },
        },
        // The page leaves on hide and again on close: each edit is saved once.
        "page.leave": {
          guard: "hasLeaveSave",
          actions: [
            {
              type: "saveOnLeave",
              params: ({ context }) => ({ changedIds: context.changedIds, result: getResult(context) }),
            },
            assign({ changedIds: new Set() }),
          ],
        },
        "sync.refresh": "syncing",
        "project.move": { target: "syncing", actions: { type: "move", params: ({ event }) => event } },
      },
    },
    syncing: {
      entry: assign({ dirty: false, changedIds: new Set(), cycleWrites: new Map() }),
      on: {
        "cycle.write.start": { actions: { type: "recordWrite", params: ({ event }) => event } },
        "cycle.write.done": { actions: { type: "recordWrite", params: ({ event }) => event } },
        "projects.change": {
          guard: { type: "hasEdits", params: ({ event }) => event.changes },
          actions: [{ type: "recordEdits", params: ({ event }) => event.changes }, assign({ dirty: true })],
        },
        "sync.refresh": { actions: assign({ dirty: true }) },
        "project.move": { actions: [{ type: "move", params: ({ event }) => event }, assign({ dirty: true })] },
      },
      invoke: {
        src: "runCycle",
        input: ({ context, self }) => getCycleInput(context, (event) => self.send(event)),
        onDone: {
          target: "settled",
          actions: { type: "applyResult", params: ({ event }) => event.output },
        },
        onError: [
          {
            guard: ({ event }) => hasErrorCode(event.error, "sign_in_required"),
            target: "endingSession",
            actions: "reportSessionEnded",
          },
          {
            guard: ({ event }) => hasErrorCode(event.error, "account_changed"),
            target: "endingSession",
            actions: [assign({ error: ({ event }) => getErrorText(event.error) }), "reportSessionEnded"],
          },
          {
            guard: ({ event }) => hasErrorCode(event.error, "cloud_sync_unavailable"),
            target: "unavailable",
            actions: assign({ error: ({ event }) => getErrorText(event.error) }),
          },
          { target: "offline", actions: assign({ error: ({ event }) => getErrorText(event.error) }) },
        ],
      },
    },
    settled: {
      always: [{ guard: "isDirty", target: "debouncing" }, { target: "idle" }],
    },
    offline: {
      after: { [offlineRetryMs]: "syncing" },
      on: {
        "sync.refresh": "syncing",
        "project.move": { target: "syncing", actions: { type: "move", params: ({ event }) => event } },
      },
    },
    unavailable: {
      on: { "account.leave": "leaving.signingOut" },
    },
    leaving: {
      entry: assign({ leavePolicy: "require_saved", leaveUnsavedIds: [] }),
      initial: "asking",
      on: { "account.leave": {} },
      states: {
        asking: {
          on: {
            "leave.confirm": "flushing",
            "leave.cancel": "#cloudSync.syncing",
          },
        },
        // One last cycle saves the edits made since the last one, so the account holds what leaves this browser.
        flushing: {
          entry: assign({
            changedIds: new Set(),
            cycleWrites: new Map(),
            leaveUnsavedIds: [],
            leavePolicy: "require_saved",
          }),
          on: {
            "cycle.write.start": { actions: { type: "recordWrite", params: ({ event }) => event } },
            "cycle.write.done": { actions: { type: "recordWrite", params: ({ event }) => event } },
            "projects.change": { actions: { type: "recordEdits", params: ({ event }) => event.changes } },
          },
          invoke: {
            src: "runCycle",
            input: ({ context, self }) => getCycleInput(context, (event) => self.send(event)),
            onDone: [
              {
                guard: {
                  type: "hasUnsavedProjects",
                  params: ({ context, event }) => getLeaveResult(context, event.output),
                },
                target: "unsaved",
                actions: [
                  { type: "applyResult", params: ({ context, event }) => getLeaveResult(context, event.output) },
                  assign({ leaveUnsavedIds: ({ context }) => getUnsavedProjectIds(context.result) }),
                ],
              },
              { target: "removing", actions: { type: "applyResult", params: ({ event }) => event.output } },
            ],
            onError: [
              {
                guard: ({ event }) => hasErrorCode(event.error, "sign_in_required"),
                target: "#cloudSync.endingSession",
                actions: "reportSessionEnded",
              },
              { target: "unsaved", actions: assign({ error: ({ event }) => getErrorText(event.error) }) },
            ],
          },
        },
        // Some edits did not reach the account, or the account could not be reached.
        unsaved: {
          on: {
            "leave.retry": "flushing",
            "leave.confirm": { target: "removing", actions: assign({ leavePolicy: "discard" }) },
            "leave.cancel": "#cloudSync.syncing",
          },
        },
        removing: {
          on: { "account.clear": {}, "account.set": {} },
          invoke: {
            src: "leaveAccount",
            input: ({ context }) => ({ ...getAccount(context), policy: context.leavePolicy }),
            onDone: [
              {
                guard: ({ event }) => event.output.kind === "unsaved",
                target: "unsaved",
                actions: assign({
                  leaveUnsavedIds: ({ event }) => (event.output.kind === "unsaved" ? event.output.projectIds : []),
                }),
              },
              { target: "#cloudSync.signedOut", actions: assign(() => initialContext) },
            ],
            onError: {
              target: "unsaved",
              actions: assign({ error: ({ event }) => getErrorText(event.error) }),
            },
          },
        },
        // The session this sign-out ends may still be read as signed in until it lands.
        signingOut: {
          on: { "account.set": {}, "account.clear": {} },
          invoke: {
            src: "signOut",
            onDone: { target: "#cloudSync.signedOut", actions: assign(() => initialContext) },
            onError: [
              {
                guard: "isSignedIn",
                target: "#cloudSync.syncing",
                actions: assign({ error: ({ event }) => getErrorText(event.error) }),
              },
              { target: "#cloudSync.signedOut", actions: assign({ error: ({ event }) => getErrorText(event.error) }) },
            ],
          },
        },
      },
    },
  },
});
