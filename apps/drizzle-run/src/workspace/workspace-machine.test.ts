import { describe, expect, it, vi } from "vitest";
import { createActor, waitFor } from "xstate";

import { createProject } from "../project/projects";
import { waitUntilSaved, workspaceMachine } from "./workspace-machine";

function makeProject(name = "Project") {
  return createProject(name, { dialect: "sqlite" });
}

function makeHeldLoad() {
  const load = Promise.withResolvers<ReturnType<typeof makeProject>[]>();

  return { load: () => load.promise, finish: load.resolve, fail: load.reject };
}

describe("workspaceMachine", () => {
  it("should save a project added while the projects load, beside the loaded ones", async () => {
    const stored = makeProject("Stored");
    const added = makeProject("Added");
    const held = makeHeldLoad();
    const save = vi.fn().mockResolvedValue(undefined);
    const actor = createActor(workspaceMachine, { input: { storage: { load: held.load, save } } }).start();

    actor.send({ type: "projects.add", projects: [added] });
    const saved = waitUntilSaved(actor, actor.getSnapshot().context.revision);
    held.finish([stored]);
    await saved;

    expect(save).toHaveBeenLastCalledWith([stored, added]);
    actor.stop();
  });

  it("should refuse a full-list change before the stored projects load", async () => {
    const held = makeHeldLoad();
    const save = vi.fn().mockResolvedValue(undefined);
    const stored = makeProject("Stored");
    const actor = createActor(workspaceMachine, { input: { storage: { load: held.load, save } } }).start();

    actor.send({ type: "projects.change", projects: [] });
    held.finish([stored]);
    await waitFor(actor, (snapshot) => snapshot.matches("saved"));

    expect(actor.getSnapshot().context.projects).toEqual([stored]);
    expect(save).not.toHaveBeenCalled();
    actor.stop();
  });

  it("should reject the wait for a save when the stored projects could not load", async () => {
    const held = makeHeldLoad();
    const actor = createActor(workspaceMachine, {
      input: { storage: { load: held.load, save: vi.fn().mockResolvedValue(undefined) } },
    }).start();

    actor.send({ type: "projects.add", projects: [makeProject()] });
    const saved = waitUntilSaved(actor, actor.getSnapshot().context.revision);
    held.fail(new Error("Local storage is unavailable"));

    await expect(saved).rejects.toThrow("Local storage is unavailable");
    actor.stop();
  });
});
