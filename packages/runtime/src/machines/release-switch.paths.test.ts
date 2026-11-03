import { listSupportedTuples } from "@drizzle-run/core/catalog";
import { moveManifestToPair } from "@drizzle-run/core/manifest";
import {
  type ActorOutcome,
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { projectManifest } from "@drizzle-run/test-fixtures";
import { describe, expect, it } from "vitest";
import { createActor, type SnapshotFrom } from "xstate";

import { releaseSwitchMachine } from "./release-switch.ts";

const [legacy, next] = listSupportedTuples({ dialect: "postgresql" });
const sqliteNext = listSupportedTuples({ dialect: "sqlite" }).find((tuple) => tuple.releaseLine === "next");

if (sqliteNext === undefined) {
  throw new Error("Expected the catalog to support a SQLite pair on the next release line");
}

const manifest = projectManifest();
const applyOutcome: ActorOutcome<void> = { outputs: [undefined], error: new Error("The project could not be saved.") };
const outcomes = {
  move: { outputs: [moveManifestToPair(manifest, next)], error: new Error("The pair could not be resolved.") },
  apply: applyOutcome,
};

const switchToNext = { type: "release.switch", manifest, tuple: next } as const;
const switchToCurrent = { type: "release.switch", manifest, tuple: legacy } as const;
const switchToOtherDatabase = { type: "release.switch", manifest, tuple: sqliteNext } as const;
const eventLabels = new Map<object, string>([
  [switchToNext, "release.switch to Next"],
  [switchToCurrent, "release.switch to the current pair"],
  [switchToOtherDatabase, "release.switch to another database"],
]);

function toModelState(snapshot: SnapshotFrom<typeof releaseSwitchMachine>) {
  return { value: snapshot.value, locked: snapshot.context.locked, error: snapshot.context.error !== "" };
}

function startReleaseSwitch() {
  const settler = createActorSettler();
  const machine = releaseSwitchMachine.provide({
    actors: { move: settler.fromOutcome(outcomes.move), apply: settler.fromOutcome(outcomes.apply) },
  });

  return { actor: createActor(machine, { input: {} }).start(), settler };
}

const paths = getMachinePaths(releaseSwitchMachine, {
  input: {},
  toModelState,
  describeEvent: (event) => eventLabels.get(event),
  events: (snapshot) => [
    switchToNext,
    switchToCurrent,
    switchToOtherDatabase,
    { type: "release.retry" },
    { type: "release.dismiss" },
    { type: "release.lock" },
    { type: "release.unlock" },
    ...getSettleEvents(snapshot, outcomes),
  ],
});

describe("release switch machine paths", () => {
  it("should take the same transitions", () => {
    expect(toTransitionTable(paths)).toMatchSnapshot();
  });

  for (const path of paths) {
    it(`should take ${path.description}`, async () => {
      const { actor, settler } = startReleaseSwitch();

      await expect(replayMachinePath(path, { actor, settler, toModelState })).resolves.toBeUndefined();
      actor.stop();
    });
  }
});
