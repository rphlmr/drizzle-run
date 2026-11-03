import {
  type ActorOutcome,
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { describe, expect, it, vi } from "vitest";
import { createActor, type SnapshotFrom } from "xstate";

import { createStartupMachine, type StartupSteps } from "./startup-machine.ts";

const agents = { names: ["claude"] };
const companion = { stop: vi.fn() };
const toolSocket = { path: "/tmp/tools.sock" };
const failure = new Error("Install Claude Code, then run this again.");

function makeSteps(): StartupSteps<typeof agents, typeof companion, typeof toolSocket> {
  return {
    pickAgents: async () => agents,
    createWorkdir: async () => "/tmp/agent",
    createCompanion: () => companion,
    openToolSocket: async () => toolSocket,
    run: async () => {},
    release: async () => {},
    log: vi.fn(),
    exit: vi.fn(),
  };
}

const startupMachine = createStartupMachine(makeSteps());

const pickAgentsOutcome: ActorOutcome<typeof agents> = { outputs: [agents], error: failure };
const createWorkdirOutcome: ActorOutcome<string> = { outputs: ["/tmp/agent"], error: failure };
const openToolSocketOutcome: ActorOutcome<typeof toolSocket | undefined> = { outputs: [toolSocket], error: failure };
const runOutcome: ActorOutcome<void> = { outputs: [], error: failure };
const releaseOutcome: ActorOutcome<void> = { outputs: [undefined] };
const outcomes = {
  pickAgents: pickAgentsOutcome,
  createWorkdir: createWorkdirOutcome,
  openToolSocket: openToolSocketOutcome,
  run: runOutcome,
  release: releaseOutcome,
};

const stopByUser = { type: "startup.stop", exitCode: 0 } as const;
const stopUnreachable = { type: "startup.stop", exitCode: 1 } as const;
const eventLabels = new Map<object, string>([
  [stopByUser, "startup.stop exit 0"],
  [stopUnreachable, "startup.stop exit 1"],
]);

function toModelState(snapshot: SnapshotFrom<typeof startupMachine>) {
  return {
    value: snapshot.value,
    exitCode: snapshot.context.exitCode,
    hasCompanion: snapshot.context.companion !== undefined,
  };
}

const paths = getMachinePaths(startupMachine, {
  toModelState,
  describeEvent: (event) => eventLabels.get(event),
  events: (snapshot) => [stopByUser, stopUnreachable, ...getSettleEvents(snapshot, outcomes)],
});

function startStartup() {
  const settler = createActorSettler();
  const machine = createStartupMachine(makeSteps()).provide({
    actors: {
      pickAgents: settler.fromOutcome(pickAgentsOutcome),
      createWorkdir: settler.fromOutcome(createWorkdirOutcome),
      openToolSocket: settler.fromOutcome<typeof toolSocket | undefined, { companion: typeof companion }>(
        openToolSocketOutcome,
      ),
      run: settler.fromOutcome<void, { companion: typeof companion }>(runOutcome),
      release: settler.fromOutcome(releaseOutcome),
    },
  });

  return { actor: createActor(machine).start(), settler };
}

describe("startup machine paths", () => {
  it("should take the same transitions", () => {
    expect(toTransitionTable(paths)).toMatchSnapshot();
  });

  for (const path of paths) {
    it(`should take ${path.description}`, async () => {
      const { actor, settler } = startStartup();

      await expect(replayMachinePath(path, { actor, settler, toModelState })).resolves.toBeUndefined();
      actor.stop();
    });
  }
});
