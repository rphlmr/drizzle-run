import { describe, expect, it } from "vitest";
import { createActor } from "xstate";

import { createProject, type ProjectRecord } from "../project/projects";
import {
  applyProjectReload,
  applyProjectWrite,
  createStoreQueueMachine,
  EMPTY_REVISIONS,
  planProjectWrite,
  resolveBaseRevisions,
  type StoreRevisions,
  type StoreTask,
} from "./store-queue-machine";

function makeProject({ id = "p1", revision = 1 }: { id?: string; revision?: number } = {}): ProjectRecord {
  return { ...createProject("Bank transfers", { dialect: "sqlite" }), id, revision };
}

function makeRevisions(known: Record<string, number>, reloads: Record<string, number> = {}): StoreRevisions {
  return { known: new Map(Object.entries(known)), reloads: new Map(Object.entries(reloads)) };
}

function makeTask(type: StoreTask["type"], run: StoreTask["run"], log: string[]): StoreTask {
  return { type, run, fail: (cause) => log.push(`${type} failed: ${String(cause)}`) };
}

describe("store queue planning", () => {
  it("should write changed projects and delete known ones the list dropped", () => {
    const write = planProjectWrite(
      [makeProject({ id: "p1", revision: 2 }), makeProject({ id: "p2", revision: 1 })],
      makeRevisions({ p1: 1, p2: 1, p3: 4 }),
    );

    expect(write.changed.map((project) => project.id)).toEqual(["p1"]);
    expect(write.deletedIds).toEqual(["p3"]);
  });

  it("should base a write on what this tab knew when it asked, once another tab's copy was read back since", () => {
    const write = planProjectWrite([makeProject({ revision: 3 })], makeRevisions({ p1: 2 }));
    const reloaded = applyProjectReload([makeProject({ revision: 5 })], [], makeRevisions({ p1: 2 }));

    expect(resolveBaseRevisions(write, reloaded)).toEqual({ p1: 2 });
  });

  it("should base a write on the last queued save when nothing was read back since", () => {
    const write = planProjectWrite([makeProject({ revision: 3 })], makeRevisions({ p1: 1 }));
    const afterEarlierSave = makeRevisions({ p1: 2 });

    expect(resolveBaseRevisions(write, afterEarlierSave)).toEqual({ p1: 2 });
  });

  it("should forget deleted projects and keep a stale project at the revision the store had", () => {
    const write = planProjectWrite(
      [makeProject({ id: "p1", revision: 3 }), makeProject({ id: "p2", revision: 2 })],
      makeRevisions({ p1: 2, p2: 1, p3: 1 }),
    );
    const written = applyProjectWrite(write, new Set(["p2"]), makeRevisions({ p1: 2, p2: 1, p3: 1 }));

    expect(Object.fromEntries(written.known)).toEqual({ p1: 3, p2: 1 });
  });
});

describe("store queue machine", () => {
  it("should run one task at a time, and plan a save sent while one settles against its revisions", async () => {
    const log: string[] = [];
    const firstRun = Promise.withResolvers<void>();
    const actor = createActor(createStoreQueueMachine()).start();
    const queueSaveOfP1 = () =>
      actor.send({
        type: "write.queued",
        projects: [makeProject({ revision: 2 })],
        createTask: (write) => {
          log.push(`save planned with ${write.changed.length} changed`);

          return makeTask("write", async (revisions) => ({ revisions, settle: () => {} }), log);
        },
      });

    actor.send({
      type: "task.queued",
      task: makeTask(
        "reload",
        async () => {
          log.push("reload ran");
          await firstRun.promise;

          return { revisions: makeRevisions({ p1: 2 }), settle: queueSaveOfP1 };
        },
        log,
      ),
    });
    actor.send({
      type: "task.queued",
      task: makeTask(
        "load",
        async (revisions) => {
          log.push(`load ran at ${revisions.known.get("p1")}`);

          return { revisions, settle: () => {} };
        },
        log,
      ),
    });
    await Promise.resolve();

    expect(log).toEqual(["reload ran"]);

    firstRun.resolve();
    await expect.poll(() => actor.getSnapshot().context.tasks.length).toBe(0);

    expect(log).toEqual(["reload ran", "load ran at 2", "save planned with 0 changed"]);
  });

  it("should keep the revisions and run the next task when one fails", async () => {
    const log: string[] = [];
    const actor = createActor(createStoreQueueMachine()).start();

    actor.send({
      type: "task.queued",
      task: makeTask(
        "load",
        async () => {
          throw new Error("The store worker failed to start.");
        },
        log,
      ),
    });
    actor.send({
      type: "task.queued",
      task: makeTask("write", async (revisions) => ({ revisions, settle: () => log.push("write settled") }), log),
    });
    await expect.poll(() => actor.getSnapshot().context.tasks.length).toBe(0);

    expect(log).toEqual(["load failed: Error: The store worker failed to start.", "write settled"]);
    expect(actor.getSnapshot().context.revisions).toBe(EMPTY_REVISIONS);
  });
});
