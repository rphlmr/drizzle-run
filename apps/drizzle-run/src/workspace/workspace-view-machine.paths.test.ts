import { createActorSettler, getMachinePaths, replayMachinePath, toTransitionTable } from "@drizzle-run/machine-paths";
import { describe, expect, it } from "vitest";
import { createActor, type SnapshotFrom } from "xstate";

import { workspaceViewMachine, type WorkspaceViewInput } from "./workspace-view-machine";

const showCode = { type: "code.show" } as const;
const showCodeOfFirstSide = { type: "code.show", side: 0 } as const;
const showCodeOfSecondSide = { type: "code.show", side: 1 } as const;
const showOutput = { type: "output.show" } as const;
const showOutputOfFirstSide = { type: "output.show", side: 0 } as const;
const showOutputOfSecondSide = { type: "output.show", side: 1 } as const;
const showFirstSide = { type: "side.show", side: 0 } as const;
const showSecondSide = { type: "side.show", side: 1 } as const;
const runSettledOnPhone = { type: "run.settled", phone: true } as const;
const runSettledOnDesktop = { type: "run.settled", phone: false } as const;
const eventLabels = new Map<object, string>([
  [showCode, "code.show"],
  [showCodeOfFirstSide, "code.show of the first side"],
  [showCodeOfSecondSide, "code.show of the second side"],
  [showOutput, "output.show"],
  [showOutputOfFirstSide, "output.show of the first side"],
  [showOutputOfSecondSide, "output.show of the second side"],
  [showFirstSide, "side.show of the first side"],
  [showSecondSide, "side.show of the second side"],
  [runSettledOnPhone, "run.settled on a phone"],
  [runSettledOnDesktop, "run.settled on a desktop"],
]);

const inputs = [
  { label: "without a side panel view", input: { asideView: false, afterRun: "output" } },
  { label: "with a side panel that shows the verdict", input: { asideView: true, afterRun: "aside" } },
  { label: "with a side panel and the output after a run", input: { asideView: true, afterRun: "output" } },
] satisfies { label: string; input: WorkspaceViewInput }[];

function toModelState(snapshot: SnapshotFrom<typeof workspaceViewMachine>) {
  return { value: snapshot.value, side: snapshot.context.side, unseenOutput: snapshot.context.unseenOutput };
}

for (const { label, input } of inputs) {
  const paths = getMachinePaths(workspaceViewMachine, {
    input,
    toModelState,
    describeEvent: (event) => eventLabels.get(event),
    events: () => [
      { type: "aside.show" },
      { type: "work.show" },
      showCode,
      showCodeOfFirstSide,
      showCodeOfSecondSide,
      showOutput,
      showOutputOfFirstSide,
      showOutputOfSecondSide,
      showFirstSide,
      showSecondSide,
      runSettledOnPhone,
      runSettledOnDesktop,
    ],
  });

  describe(`workspace view machine paths ${label}`, () => {
    it("should take the same transitions", () => {
      expect(toTransitionTable(paths)).toMatchSnapshot();
    });

    for (const path of paths) {
      it(`should take ${path.description}`, async () => {
        const actor = createActor(workspaceViewMachine, { input }).start();

        await expect(
          replayMachinePath(path, { actor, settler: createActorSettler(), toModelState }),
        ).resolves.toBeUndefined();
        actor.stop();
      });
    }
  });
}
