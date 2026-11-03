import {
  createActorSettler,
  getMachinePaths,
  type ModelEvent,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, type SnapshotFrom } from "xstate";

import { createEmbedMachine, type EmbedHostOrigin, type EmbedLoaderEffects } from "./machine.js";

const REQUEST_TIMEOUT_MS = 30_000;
const TIMEOUT_EVENT = { type: "xstate.after.requestTimeout.embed.frame.loading" } as const;
const FIRST_NONCE = "a".repeat(32);
const SECOND_NONCE = "b".repeat(32);

function makeEffects(): EmbedLoaderEffects {
  return {
    showDormant: vi.fn(),
    openFrame: vi.fn(),
    connectFrame: vi.fn(),
    revealFrame: vi.fn(),
    removeFrame: vi.fn(),
    showFailure: vi.fn(),
    showUnsupported: vi.fn(),
    notifyReady: vi.fn(),
    notifyCapability: vi.fn(),
    notifyError: vi.fn(),
    notifyRunSettled: vi.fn(),
    restoreHost: vi.fn(),
  };
}

const embedMachine = createEmbedMachine(makeEffects());
const nonces = [
  { label: "the first attempt", nonce: FIRST_NONCE },
  { label: "the second attempt", nonce: SECOND_NONCE },
];
const loadEvents = [
  { event: { type: "embed.load.activate", nonce: FIRST_NONCE }, label: "embed.load.activate" },
  { event: { type: "embed.load.activate", nonce: null }, label: "embed.load.activate without a nonce" },
  { event: { type: "embed.load.retry", nonce: SECOND_NONCE }, label: "embed.load.retry" },
  { event: { type: "embed.load.retry", nonce: null }, label: "embed.load.retry without a nonce" },
] as const;
const frameEvents = nonces.flatMap(({ label, nonce }) => [
  { event: { type: "embed.frame.hello", nonce }, label: `embed.frame.hello from ${label}` },
  { event: { type: "embed.frame.ready", nonce }, label: `embed.frame.ready from ${label}` },
  {
    event: { type: "embed.frame.capability", nonce, status: "available" },
    label: `embed.frame.capability available from ${label}`,
  },
  {
    event: { type: "embed.frame.capability", nonce, status: "recorded" },
    label: `embed.frame.capability recorded from ${label}`,
  },
  {
    event: { type: "embed.frame.capability", nonce, status: "browser_unsupported" },
    label: `embed.frame.capability browser unsupported from ${label}`,
  },
  {
    event: { type: "embed.frame.error", nonce, code: "not_found" },
    label: `embed.frame.error not found from ${label}`,
  },
  {
    event: { type: "embed.frame.error", nonce, code: "initialization" },
    label: `embed.frame.error initialization from ${label}`,
  },
  {
    event: { type: "embed.frame.run.settled", nonce, run: { outcome: "succeeded", displays: [], truncated: false } },
    label: `embed.frame.run.settled from ${label}`,
  },
]);
const labelledEvents = [
  ...loadEvents,
  ...frameEvents,
  { event: { type: "embed.dispose" }, label: "embed.dispose" },
  { event: TIMEOUT_EVENT, label: `after ${REQUEST_TIMEOUT_MS} ms` },
] satisfies { event: ModelEvent; label: string }[];
const eventLabels = new Map<unknown, string>(labelledEvents.map(({ event, label }) => [event, label]));

function toModelState(snapshot: SnapshotFrom<typeof embedMachine>) {
  const attempt = nonces.find(({ nonce }) => nonce === snapshot.context.nonce);

  return { value: snapshot.value, attempt: attempt === undefined ? "none" : attempt.label };
}

const inputs: { label: string; hostOrigin: EmbedHostOrigin }[] = [
  { label: "on a page with an origin", hostOrigin: "tuple" },
  { label: "on an opaque page", hostOrigin: "opaque" },
];

async function advanceTimers(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("embed loader machine paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  for (const { label, hostOrigin } of inputs) {
    const paths = getMachinePaths(embedMachine, {
      input: { hostOrigin },
      toModelState,
      describeEvent: (event) => eventLabels.get(event),
      events: (snapshot) =>
        labelledEvents
          .map(({ event }) => event)
          .filter((event) => event !== TIMEOUT_EVENT || snapshot.matches({ frame: "loading" })),
    });

    describe(`${label} paths`, () => {
      it("should take the same transitions", () => {
        expect(toTransitionTable(paths)).toMatchSnapshot();
      });

      for (const path of paths) {
        it(`should take ${path.description}`, async () => {
          const actor = createActor(createEmbedMachine(makeEffects()), { input: { hostOrigin } }).start();

          await expect(
            replayMachinePath(path, {
              actor,
              settler: createActorSettler(),
              toModelState,
              advance: () => advanceTimers(REQUEST_TIMEOUT_MS),
              flush: () => advanceTimers(0),
            }),
          ).resolves.toBeUndefined();
          actor.stop();
        });
      }
    });
  }
});
