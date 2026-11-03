import { digestCloudProject } from "@drizzle-run/core/contracts";
import { assign, fromPromise, setup } from "xstate";

import { declareType } from "../lib/declare-type";
import { getErrorText } from "../lib/error-text";
import type { ProjectRecord } from "../project/projects";
import type { CloudSyncState } from "../store/storage";
import type { CloudSignOutInput, CloudSignOutResult } from "./session-contract";

/** The Cloud projects of an account in this browser, and how many hold edits the account lacks. */
export interface StoredCloudProjects {
  cloudCount: number;
  unsavedCount: number;
}

/**
 * Count the Cloud projects of `githubId` in this browser
 *
 * A project is unsaved when its content is not the one the account last took from this browser: edited since, or
 * never saved to the account.
 */
export async function countStoredCloudProjects(
  store: {
    loadCloudSync: (githubId: number) => Promise<CloudSyncState[]>;
    readProject: (projectId: string) => Promise<ProjectRecord | null>;
  },
  githubId: number,
): Promise<StoredCloudProjects> {
  const rows = await store.loadCloudSync(githubId);
  const projects = await Promise.all(rows.map((row) => store.readProject(row.projectId)));
  let cloudCount = 0;
  let unsavedCount = 0;

  for (const [index, row] of rows.entries()) {
    const project = projects[index] ?? null;

    if (project === null) {
      continue;
    }

    cloudCount += 1;

    if (row.revision === 0 || digestCloudProject(project) !== row.digest) {
      unsavedCount += 1;
    }
  }

  return { cloudCount, unsavedCount };
}

/** The store work and the session call behind a sign-out made where no workspace is open. */
export interface StandaloneSignOutDependencies {
  countCloudProjects: (githubId: number) => Promise<StoredCloudProjects>;
  leaveAccount: (input: CloudSignOutInput, signal: AbortSignal) => Promise<CloudSignOutResult>;
}

interface StandaloneSignOutContext {
  githubId: number;
  /** Cloud projects whose edits the account lacks: signing out loses them. */
  unsavedCount: number;
  /** Why reading or removing the Cloud projects failed; empty otherwise. */
  error: string;
}

/** The events of the standalone sign-out machine. */
export type StandaloneSignOutEvent =
  | { type: "sign_out.start"; githubId: number }
  | { type: "sign_out.confirm" }
  | { type: "sign_out.retry" }
  | { type: "sign_out.cancel" };

/**
 * Create the sign-out machine for pages without the workspace, such as a shared link
 *
 * ```text
 * idle ─start─► checking ─(no Cloud project)─► removing ─► idle
 *                  │       └─(some)─► asking ─confirm─► removing
 *                                     ▲                  │
 *                                     └─(new unsaved edits)┘
 *                  └─(error)─► failed ◄─────────────────(error)─┘
 * asking | failed ─cancel─► idle        failed ─retry─► checking
 * ```
 *
 * It reads the store alone: no project is open here, so every edit is stored, though some may not be in the account.
 * Every Cloud project leaves, as from the workspace; the dialog says when that loses edits. The session ends only once
 * they left.
 */
export function createStandaloneSignOutMachine({ countCloudProjects, leaveAccount }: StandaloneSignOutDependencies) {
  return setup({
    types: {
      context: declareType<StandaloneSignOutContext>(),
      events: declareType<StandaloneSignOutEvent>(),
    },
    actors: {
      countCloudProjects: fromPromise<StoredCloudProjects, { githubId: number }>(({ input }) =>
        countCloudProjects(input.githubId),
      ),
      leaveAccount: fromPromise<CloudSignOutResult, CloudSignOutInput>(({ input, signal }) =>
        leaveAccount(input, signal),
      ),
    },
    guards: {
      hasNoCloudProject: (_, output: StoredCloudProjects) => output.cloudCount === 0,
    },
  }).createMachine({
    id: "standaloneSignOut",
    context: { githubId: 0, unsavedCount: 0, error: "" },
    initial: "idle",
    states: {
      idle: {
        on: {
          "sign_out.start": {
            target: "checking",
            actions: assign({ githubId: ({ event }) => event.githubId, unsavedCount: 0, error: "" }),
          },
        },
      },
      checking: {
        invoke: {
          src: "countCloudProjects",
          input: ({ context }) => ({ githubId: context.githubId }),
          onDone: [
            { guard: { type: "hasNoCloudProject", params: ({ event }) => event.output }, target: "removing" },
            { target: "asking", actions: assign({ unsavedCount: ({ event }) => event.output.unsavedCount }) },
          ],
          onError: { target: "failed", actions: assign({ error: ({ event }) => getErrorText(event.error) }) },
        },
      },
      asking: {
        on: {
          "sign_out.confirm": "removing",
          "sign_out.cancel": "idle",
        },
      },
      removing: {
        invoke: {
          src: "leaveAccount",
          input: ({ context }) => ({
            githubId: context.githubId,
            policy: context.unsavedCount > 0 ? "discard" : "require_saved",
          }),
          onDone: [
            {
              guard: ({ event }) => event.output.kind === "unsaved",
              target: "asking",
              actions: assign({
                unsavedCount: ({ event }) => (event.output.kind === "unsaved" ? event.output.projectIds.length : 0),
              }),
            },
            { target: "idle" },
          ],
          onError: { target: "failed", actions: assign({ error: ({ event }) => getErrorText(event.error) }) },
        },
      },
      failed: {
        on: {
          "sign_out.retry": "checking",
          "sign_out.cancel": "idle",
        },
      },
    },
  });
}
