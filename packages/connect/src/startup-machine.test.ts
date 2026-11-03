import { describe, expect, it, vi } from "vitest";
import { createActor, waitFor } from "xstate";

import { createStartupMachine, type StartupCompanion, type StartupSteps } from "./startup-machine.ts";

type TestSteps = StartupSteps<string[], StartupCompanion, string>;

function makeSteps(overrides: Partial<TestSteps> = {}) {
  const createCompanion = vi.fn(() => ({ stop: vi.fn() }));
  const release = vi.fn(async () => {});
  const log = vi.fn();
  const exit = vi.fn();
  const steps: TestSteps = {
    pickAgents: async () => ["claude"],
    createWorkdir: async () => "/tmp/agent",
    createCompanion,
    openToolSocket: async () => "/tmp/tools.sock",
    run: async () => {},
    release,
    log,
    exit,
    ...overrides,
  };

  return { steps, createCompanion, release, log, exit };
}

describe("createStartupMachine", () => {
  it("should await companion termination before releasing resources and exiting", async () => {
    const termination = Promise.withResolvers<void>();
    const { steps, release, exit } = makeSteps({ createCompanion: () => ({ stop: () => termination.promise }) });
    const startup = createActor(createStartupMachine(steps)).start();

    await waitFor(startup, (snapshot) => snapshot.matches({ starting: "running" }));
    startup.send({ type: "startup.stop", exitCode: 0 });
    await Promise.resolve();

    expect(release).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    termination.resolve();
    await waitFor(startup, (snapshot) => snapshot.status === "done");
    expect(release).toHaveBeenCalledOnce();
  });
  it("should start nothing more after a stop that comes while the agent folder is made", async () => {
    const workdir = Promise.withResolvers<string>();
    const { steps, createCompanion, release, exit } = makeSteps({ createWorkdir: () => workdir.promise });
    const startup = createActor(createStartupMachine(steps)).start();

    await waitFor(startup, (snapshot) => snapshot.matches({ starting: "creatingWorkdir" }));
    startup.send({ type: "startup.stop", exitCode: 0 });
    workdir.resolve("/tmp/agent");
    await waitFor(startup, (snapshot) => snapshot.status === "done");

    expect(createCompanion).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("should abort the agent checks when a stop comes while they run", async () => {
    let checksSignal: AbortSignal | undefined;
    const { steps, exit } = makeSteps({
      pickAgents: (signal) => {
        checksSignal = signal;

        return new Promise<string[]>(() => {});
      },
    });
    const startup = createActor(createStartupMachine(steps)).start();

    startup.send({ type: "startup.stop", exitCode: 130 });
    await waitFor(startup, (snapshot) => snapshot.status === "done");

    expect(checksSignal?.aborted).toBe(true);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("should stop the companion, release the folder and exit 1 when the companion fails to start", async () => {
    const companion = { stop: vi.fn() };
    const { steps, release, log, exit } = makeSteps({
      createCompanion: () => companion,
      run: async () => {
        throw new Error("The relay URL is not valid.");
      },
    });
    const startup = createActor(createStartupMachine(steps)).start();

    await waitFor(startup, (snapshot) => snapshot.status === "done");

    expect(log).toHaveBeenCalledWith("The relay URL is not valid.");
    expect(companion.stop).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
