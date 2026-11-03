import {
  type ActorOutcome,
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  type ModelEvent,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { describe, expect, it } from "vitest";
import { createActor, type InputFrom, type SnapshotFrom } from "xstate";

import { VolatileProjectStorage, type ShareLinkRecord } from "../store/storage";
import type { DeletePlaygroundOutcome } from "./playgrounds-contract";
import { shareDeleteMachine } from "./share-delete-machine";

const link: ShareLinkRecord = {
  linkId: "123e4567-e89b-42d3-a456-426614174000",
  publishedAt: "2026-10-10T00:00:00.000Z",
};
const deleteRemoteOutcome: ActorOutcome<DeletePlaygroundOutcome> = {
  outputs: ["deleted", "alreadyGone"],
  error: new Error("The Worker is unavailable."),
};
const forgetLinkOutcome: ActorOutcome<void> = {
  outputs: [undefined],
  error: new Error("The local store is unavailable."),
};
const outcomes = {
  deleteRemote: deleteRemoteOutcome,
  forgetLink: forgetLinkOutcome,
} satisfies Record<string, ActorOutcome<unknown>>;

const open = { type: "delete.open", link } as const;
const cancel = { type: "delete.cancel" } as const;
const confirm = { type: "delete.confirm" } as const;
const retryCleanup = { type: "cleanup.retry" } as const;

const input = {
  services: {
    playgrounds: { deletePlayground: () => Promise.reject(new Error("Replayed paths settle fakes instead.")) },
    links: new VolatileProjectStorage(),
  },
  projectIds: ["project-1"],
} satisfies InputFrom<typeof shareDeleteMachine>;

function describeEvent(event: ModelEvent) {
  const settled = /^xstate\.done\.actor\.0\.shareDelete\.(\w+)$/.exec(event.type);

  if (settled !== null && typeof event.output === "string") {
    return `done(${settled[1]}) ${event.output}`;
  }

  return undefined;
}

function toModelState(snapshot: SnapshotFrom<typeof shareDeleteMachine>) {
  const { link: chosen, error, outcome } = snapshot.context;

  return { value: snapshot.value, link: chosen !== undefined, error: error !== "", outcome: outcome ?? "none" };
}

function startShareDelete() {
  const settler = createActorSettler();
  const machine = shareDeleteMachine.provide({
    actors: {
      deleteRemote: settler.fromOutcome(outcomes.deleteRemote),
      forgetLink: settler.fromOutcome(outcomes.forgetLink),
    },
  });

  return { actor: createActor(machine, { input }).start(), settler };
}

describe("share delete machine paths", () => {
  const paths = getMachinePaths(shareDeleteMachine, {
    input,
    toModelState,
    describeEvent,
    events: (snapshot) => [open, cancel, confirm, retryCleanup, ...getSettleEvents(snapshot, outcomes)],
  });

  it("should take the same transitions", () => {
    expect(toTransitionTable(paths)).toMatchSnapshot();
  });

  for (const path of paths) {
    it(`should take ${path.description}`, async () => {
      const { actor, settler } = startShareDelete();

      try {
        await expect(replayMachinePath(path, { actor, settler, toModelState })).resolves.toBeUndefined();
      } finally {
        actor.stop();
      }
    });
  }
});
