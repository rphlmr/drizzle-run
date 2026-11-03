import { assign, createActor, fromPromise, setup, toPromise } from "xstate";

import { declareType } from "../src/lib/declare-type.ts";

type ReleaseStep = "build" | "upload" | "migrate" | "deploy" | "verify" | "prune";
type ReleaseSteps = Record<ReleaseStep, () => Promise<void>>;

/**
 * A production release of Drizzle Run, in the order that keeps a working deployment at every step
 *
 * ```text
 * building ─► uploading ─► migrating ─► deploying ─► verifying ─► pruning ─► released
 *     └───────────┴────────────┴────────────┴────────────┴───────────┴─► failed (failedStep, error)
 * ```
 *
 * The D1 migrations run before the deploy, so the new Worker never meets an older schema; the previous Worker serves
 * meanwhile, so a migration must keep working for it. The prune runs only after the new Worker serves its own runtime
 * assets: until then, the previous deployment's objects stay in R2. Each step is an async function `release-drizzle-run.ts` injects; the
 * placeholders throw so a missing step fails the release instead of skipping it.
 */
export const releaseMachine = setup({
  types: {
    context: declareType<{ failedStep: ReleaseStep | null; error: unknown }>(),
  },
  actors: {
    build: fromPromise<void>(async () => {
      throw new Error("The release build step was not provided");
    }),
    upload: fromPromise<void>(async () => {
      throw new Error("The release upload step was not provided");
    }),
    migrate: fromPromise<void>(async () => {
      throw new Error("The release migrate step was not provided");
    }),
    deploy: fromPromise<void>(async () => {
      throw new Error("The release deploy step was not provided");
    }),
    verify: fromPromise<void>(async () => {
      throw new Error("The release verify step was not provided");
    }),
    prune: fromPromise<void>(async () => {
      throw new Error("The release prune step was not provided");
    }),
  },
}).createMachine({
  id: "release",
  initial: "building",
  context: { failedStep: null, error: null },
  states: {
    building: {
      invoke: {
        src: "build",
        onDone: "uploading",
        onError: { target: "failed", actions: assign({ failedStep: "build", error: ({ event }) => event.error }) },
      },
    },
    uploading: {
      invoke: {
        src: "upload",
        onDone: "migrating",
        onError: { target: "failed", actions: assign({ failedStep: "upload", error: ({ event }) => event.error }) },
      },
    },
    migrating: {
      invoke: {
        src: "migrate",
        onDone: "deploying",
        onError: { target: "failed", actions: assign({ failedStep: "migrate", error: ({ event }) => event.error }) },
      },
    },
    deploying: {
      invoke: {
        src: "deploy",
        onDone: "verifying",
        onError: { target: "failed", actions: assign({ failedStep: "deploy", error: ({ event }) => event.error }) },
      },
    },
    verifying: {
      invoke: {
        src: "verify",
        onDone: "pruning",
        onError: { target: "failed", actions: assign({ failedStep: "verify", error: ({ event }) => event.error }) },
      },
    },
    pruning: {
      invoke: {
        src: "prune",
        onDone: "released",
        onError: { target: "failed", actions: assign({ failedStep: "prune", error: ({ event }) => event.error }) },
      },
    },
    released: { type: "final" },
    failed: { type: "final" },
  },
});

/**
 * Run a release
 *
 * @param steps - `{ build, upload, migrate, deploy, verify, prune }`, each an async function that throws on failure
 * @returns The final snapshot: `released`, or `failed` with `context.failedStep` and `context.error`
 */
export async function runRelease(steps: ReleaseSteps) {
  const actor = createActor(
    releaseMachine.provide({
      actors: {
        build: fromPromise(steps.build),
        upload: fromPromise(steps.upload),
        migrate: fromPromise(steps.migrate),
        deploy: fromPromise(steps.deploy),
        verify: fromPromise(steps.verify),
        prune: fromPromise(steps.prune),
      },
    }),
  ).start();

  await toPromise(actor);

  return actor.getSnapshot();
}
