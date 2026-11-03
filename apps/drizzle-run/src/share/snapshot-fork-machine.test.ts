import { describe, expect, it } from "vitest";
import { createActor } from "xstate";

import { createProject, type ProjectRecord } from "../project/projects";
import { createSnapshotForkMachine, requestFork } from "./snapshot-fork-machine";

function startFork() {
  const saves: PromiseWithResolvers<ProjectRecord>[] = [];
  const actor = createActor(
    createSnapshotForkMachine({
      saveFork: () => {
        const save = Promise.withResolvers<ProjectRecord>();
        saves.push(save);

        return save.promise;
      },
    }),
  ).start();

  return { actor, saves };
}

describe("createSnapshotForkMachine", () => {
  it("should refuse the agent's fork while the button's fork saves, and save only one copy", async () => {
    const { actor, saves } = startFork();
    const forked = createProject("Fork", { dialect: "sqlite" });

    const fromButton = requestFork(actor, { name: "Fork", open: true });
    const fromAgent = requestFork(actor, { name: "Agent fork", open: false });
    saves[0]?.resolve(forked);

    await expect(fromAgent).rejects.toThrow("Another fork is being saved");
    await expect(fromButton).resolves.toBe(forked);
    expect(saves).toHaveLength(1);
  });

  it("should show a failed button fork, and hand a failed agent fork back without showing it", async () => {
    const { actor, saves } = startFork();

    const fromAgent = requestFork(actor, { name: "Agent fork", open: false });
    saves[0]?.reject(new Error("Disk full"));
    await expect(fromAgent).rejects.toThrow("Disk full");
    const afterAgent = actor.getSnapshot().context.error;
    const fromButton = requestFork(actor, { name: "Fork", open: true });
    saves[1]?.reject(new Error("Disk full"));
    await expect(fromButton).rejects.toThrow("Disk full");

    expect(afterAgent).toBe("");
    expect(actor.getSnapshot().context.error).toBe("Disk full");
  });

  it("should answer a waiting fork when the page closes", async () => {
    const { actor } = startFork();

    const fromButton = requestFork(actor, { name: "Fork", open: true });
    actor.stop();

    await expect(fromButton).rejects.toThrow("closed before the fork was saved");
  });
});
