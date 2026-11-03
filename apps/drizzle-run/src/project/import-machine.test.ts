import { listSupportedTuples } from "@drizzle-run/core/catalog";
import { describe, expect, it, vi } from "vitest";
import { createActor, fromPromise, waitFor } from "xstate";

import type { ShareLinkRecord } from "../store/storage";
import {
  PROJECT_IMPORT_LIMIT,
  projectImportMachine,
  type ProjectImportEmitted,
  type ProjectImportSave,
  type RestoredShareKey,
} from "./import-machine";
import { chooseImportRelease, createProject } from "./projects";

const link: ShareLinkRecord = {
  linkId: "6f1d2c3b-4a5e-4f60-8a7b-1c2d3e4f5a6b",
  publishedAt: "2026-10-15T00:00:00.000Z",
};
const exported = createProject("Bank transfers", { dialect: "postgresql" });

function makeFile(content: string, name = "project.json") {
  return new File([content], name, { type: "application/json" });
}

function start() {
  const save = vi.fn(async (_input: ProjectImportSave) => undefined);
  const restoreShareKey = vi.fn(async (_input: readonly RestoredShareKey[]) => undefined);
  const emitted: ProjectImportEmitted[] = [];
  const actor = createActor(
    projectImportMachine.provide({
      actors: {
        save: fromPromise(({ input }) => save(input)),
        restoreShareKey: fromPromise(({ input }) => restoreShareKey(input)),
      },
    }),
  );

  actor.on("import.done", (event) => emitted.push(event));
  actor.on("import.failed", (event) => emitted.push(event));
  actor.start();

  return { actor, save, restoreShareKey, emitted };
}

function waitForIdle(actor: ReturnType<typeof start>["actor"]) {
  return waitFor(actor, (snapshot) => snapshot.matches("idle"));
}

function waitForFailure(actor: ReturnType<typeof start>["actor"]) {
  return waitFor(actor, (snapshot) => snapshot.matches("failed"));
}

describe("project import machine", () => {
  it("should read, parse, and save a project as a new local project", async () => {
    const { actor, save, restoreShareKey, emitted } = start();

    actor.send({ type: "file.pick", file: makeFile(JSON.stringify(exported)) });
    expect(actor.getSnapshot().value).toBe("reading");
    await waitForIdle(actor);

    const [
      {
        projects: [project],
        opens,
      },
    ] = save.mock.calls[0];

    expect(project.name).toBe("Bank transfers");
    expect(opens).toBe(true);
    expect(project.id).not.toBe(exported.id);
    expect(project.manifest.files).toEqual(exported.manifest.files);
    expect(restoreShareKey).not.toHaveBeenCalled();
    expect(emitted).toEqual([{ type: "import.done", projects: [project], skipped: [], retired: [], releaseNotes: [] }]);
    expect(actor.getSnapshot().context).toEqual({
      file: undefined,
      text: "",
      parsed: undefined,
      skipped: [],
      retired: [],
      opens: true,
      error: "",
    });
    actor.stop();
  });

  it("should restore the share link an export carries before saving", async () => {
    const { actor, save, restoreShareKey } = start();

    actor.send({ type: "file.pick", file: makeFile(JSON.stringify({ ...exported, shareLink: link })) });
    await waitForIdle(actor);

    const [
      {
        projects: [project],
        opens,
      },
    ] = save.mock.calls[0];

    expect(opens).toBe(true);
    expect(restoreShareKey).toHaveBeenCalledWith([{ projectId: project?.id, link }]);
    expect(restoreShareKey.mock.invocationCallOrder[0]).toBeLessThan(save.mock.invocationCallOrder[0]);
    actor.stop();
  });

  it("should import every project of a backup together, with the share links it carries", async () => {
    const { actor, save, restoreShareKey, emitted } = start();
    const second = createProject("Shop", { dialect: "sqlite" });

    actor.send({ type: "file.pick", file: makeFile(JSON.stringify([{ ...exported, shareLink: link }, second])) });
    await waitForIdle(actor);

    const [{ projects, opens }] = save.mock.calls[0];

    expect(projects.map((project) => project.name)).toEqual(["Bank transfers", "Shop"]);
    expect(opens).toBe(false);
    expect(restoreShareKey).toHaveBeenCalledWith([{ projectId: projects[0]?.id, link }]);
    expect(emitted).toEqual([{ type: "import.done", projects, skipped: [], retired: [], releaseNotes: [] }]);
    actor.stop();
  });

  it("should import a backup's readable projects and name the unreadable ones", async () => {
    const { actor, save, emitted } = start();

    actor.send({ type: "file.pick", file: makeFile(JSON.stringify([exported, {}])) });
    await waitForIdle(actor);

    const [{ projects, opens }] = save.mock.calls[0];

    expect(projects.map((project) => project.name)).toEqual(["Bank transfers"]);
    expect(opens).toBe(false);
    expect(emitted).toEqual([
      {
        type: "import.done",
        projects,
        skipped: [
          "Project 2 of 2 could not be read: Unsupported project JSON. Expected a project record or Drizzle Run manifest.",
        ],
        retired: [],
        releaseNotes: [],
      },
    ]);
    actor.stop();
  });

  it("should hold back a project on a removed pair until a release is chosen for it", async () => {
    const { actor, save, emitted } = start();
    const removed = {
      version: 1,
      name: "Old pair",
      manifest: { ...exported.manifest, dependencies: { "drizzle-orm": "1.0.0-rc.3", "drizzle-kit": "1.0.0-rc.3" } },
    };
    const next = listSupportedTuples({ dialect: "postgresql" }).find((tuple) => tuple.releaseLine === "next");

    actor.send({ type: "file.pick", file: makeFile(JSON.stringify([exported, removed])) });
    await waitForIdle(actor);

    const [{ projects, opens }] = save.mock.calls[0];
    const [imported] = emitted;
    const [retired] = imported?.type === "import.done" ? imported.retired : [];

    expect(projects.map((project) => project.name)).toEqual(["Bank transfers"]);
    expect(opens).toBe(false);
    expect(imported).toMatchObject({ type: "import.done", skipped: [] });
    expect(retired).toMatchObject({
      name: "Old pair",
      releases: [{ releaseLine: "next", ormVersion: "1.0.0-rc.3" }],
      opens: false,
    });
    expect(retired && next && chooseImportRelease(retired, [{ tupleId: next.id }]).manifest).toMatchObject({
      dependencies: { "drizzle-orm": next?.ormVersion },
    });
    actor.stop();
  });

  it("should import a lone project on a removed pair once a release is chosen, saving nothing before", async () => {
    const { actor, save, emitted } = start();
    const removed = {
      version: 1,
      name: "Old pair",
      manifest: { ...exported.manifest, dependencies: { "drizzle-orm": "1.0.0-rc.3", "drizzle-kit": "1.0.0-rc.3" } },
    };

    actor.send({ type: "file.pick", file: makeFile(JSON.stringify(removed)) });
    await waitForIdle(actor);

    expect(save.mock.calls[0]?.[0]).toEqual({ projects: [], opens: true });
    expect(emitted).toMatchObject([
      { type: "import.done", projects: [], retired: [{ name: "Old pair", opens: true }] },
    ]);
    actor.stop();
  });

  it("should keep the share link of an export on a removed pair for when a release is chosen", async () => {
    const { actor, restoreShareKey, emitted } = start();
    const removed = {
      version: 1,
      name: "Old pair",
      manifest: { ...exported.manifest, dependencies: { "drizzle-orm": "1.0.0-rc.3", "drizzle-kit": "1.0.0-rc.3" } },
      shareLink: link,
    };

    actor.send({ type: "file.pick", file: makeFile(JSON.stringify(removed)) });
    await waitForIdle(actor);

    expect(restoreShareKey).not.toHaveBeenCalled();
    expect(emitted).toMatchObject([{ type: "import.done", retired: [{ name: "Old pair", shareLink: link }] }]);
    actor.stop();
  });

  it("should refuse a file on a removed pair that no release could import, before asking for one", async () => {
    const removedPins = { "drizzle-orm": "1.0.0-rc.3", "drizzle-kit": "1.0.0-rc.3" };
    const cases = [
      { version: 1, name: "x".repeat(300), manifest: { ...exported.manifest, dependencies: removedPins } },
      { snapshotVersion: 7, name: "Snapshot", manifest: { ...exported.manifest, dependencies: removedPins } },
    ];

    for (const file of cases) {
      const { actor, emitted } = start();

      actor.send({ type: "file.pick", file: makeFile(JSON.stringify(file)) });
      await waitForFailure(actor);

      expect(emitted).toMatchObject([{ type: "import.failed" }]);
      actor.stop();
    }
  });

  it("should note a project that moved off a release Drizzle Run no longer ships", async () => {
    const { actor, emitted } = start();
    const olderLegacy = {
      version: 1,
      name: "Older legacy",
      manifest: {
        ...createProject("Older legacy", { dialect: "sqlite" }).manifest,
        dependencies: { "drizzle-orm": "0.44.0", "drizzle-kit": "0.30.0" },
      },
    };

    actor.send({ type: "file.pick", file: makeFile(JSON.stringify([exported, olderLegacy])) });
    await waitForIdle(actor);

    const [imported] = emitted;

    expect(imported?.type === "import.done" ? imported.projects : []).toHaveLength(2);
    expect(imported?.type === "import.done" ? imported.releaseNotes : []).toHaveLength(1);
    actor.stop();
  });

  it("should name only the first problem of an unreadable project", async () => {
    const { actor, emitted } = start();
    const broken = { version: 1, name: "Broken", manifest: { kind: "drizzle-run" } };

    actor.send({ type: "file.pick", file: makeFile(JSON.stringify([exported, broken])) });
    await waitForIdle(actor);

    const [imported] = emitted;
    const [skipped = ""] = imported?.type === "import.done" ? imported.skipped : [];

    expect(skipped).toMatch(/^Project 2 of 2 could not be read: [^\n]+ \(and \d+ more problems\)$/);
    actor.stop();
  });

  it("should refuse a backup with no readable project, and a file that is not JSON", async () => {
    const { actor, save } = start();

    actor.send({ type: "file.pick", file: makeFile(JSON.stringify([{}])) });
    await waitForFailure(actor);
    expect(actor.getSnapshot().context.error).toBe(
      "No project in this backup could be read. Project 1 of 1 could not be read: Unsupported project JSON. Expected a project record or Drizzle Run manifest.",
    );

    actor.send({ type: "file.pick", file: makeFile("not json") });
    await waitFor(actor, (snapshot) => snapshot.context.error.startsWith("This file is not JSON."));
    expect(save).not.toHaveBeenCalled();
    actor.stop();
  });

  it("should import a published snapshot file as someone else's untrusted project", async () => {
    const { actor, save, restoreShareKey } = start();
    const snapshot = { snapshotVersion: 1, name: exported.name, manifest: exported.manifest };

    actor.send({ type: "file.pick", file: makeFile(JSON.stringify(snapshot)) });
    await waitForIdle(actor);

    const [
      {
        projects: [project],
        opens,
      },
    ] = save.mock.calls[0];

    expect(opens).toBe(true);
    expect(restoreShareKey).not.toHaveBeenCalled();
    expect(project).toMatchObject({ origin: "community", trust: "untrusted" });
    actor.stop();
  });

  it("should refuse a file over 2 MB without reading it", () => {
    const { actor, save, emitted } = start();
    const large = makeFile("x");

    Object.defineProperty(large, "size", { value: PROJECT_IMPORT_LIMIT + 1 });
    actor.send({ type: "file.pick", file: large });

    expect(actor.getSnapshot().value).toBe("failed");
    expect(emitted).toEqual([{ type: "import.failed", error: "Import must be smaller than 2 MB." }]);
    expect(save).not.toHaveBeenCalled();

    actor.send({ type: "import.retry" });
    expect(actor.getSnapshot().value).toBe("failed");
    actor.stop();
  });

  it("should report an unreadable project, retry the same file, and accept a new pick", async () => {
    const { actor, save, emitted } = start();

    actor.send({ type: "file.pick", file: makeFile("{}") });
    await waitForFailure(actor);
    expect(actor.getSnapshot().context.error).toBe(
      "Unsupported project JSON. Expected a project record or Drizzle Run manifest.",
    );

    actor.send({ type: "import.retry" });
    expect(actor.getSnapshot().value).toBe("reading");
    await waitForFailure(actor);
    expect(emitted.filter((event) => event.type === "import.failed")).toHaveLength(2);

    actor.send({ type: "file.pick", file: makeFile(JSON.stringify(exported)) });
    await waitForIdle(actor);
    expect(save).toHaveBeenCalledOnce();
    actor.stop();
  });

  it("should fail when restoring the key or saving fails, and dismiss back to idle", async () => {
    const { actor, save, restoreShareKey } = start();

    restoreShareKey.mockRejectedValueOnce(new Error("storage blocked"));
    actor.send({ type: "file.pick", file: makeFile(JSON.stringify({ ...exported, shareLink: link })) });
    await waitForFailure(actor);
    expect(actor.getSnapshot().context.error).toBe("storage blocked");
    expect(save).not.toHaveBeenCalled();

    save.mockRejectedValueOnce(new Error("quota"));
    actor.send({ type: "import.retry" });
    await waitFor(actor, (snapshot) => snapshot.matches("failed") && snapshot.context.error === "quota");

    actor.send({ type: "import.dismiss" });
    expect(actor.getSnapshot()).toMatchObject({ value: "idle", context: { error: "", file: undefined } });
    actor.stop();
  });

  it("should ignore Retry and Dismiss when idle, and a second pick while busy", async () => {
    const { actor, save } = start();

    actor.send({ type: "import.retry" });
    actor.send({ type: "import.dismiss" });
    expect(actor.getSnapshot().value).toBe("idle");

    actor.send({ type: "file.pick", file: makeFile(JSON.stringify(exported)) });
    actor.send({ type: "file.pick", file: makeFile("{}") });
    actor.send({ type: "import.retry" });
    await waitForIdle(actor);

    expect(save).toHaveBeenCalledOnce();
    actor.stop();
  });
});
