import { describe, expect, it, vi } from "vitest";
import { createActor, waitFor } from "xstate";

import type { QueuedRetiredImport } from "../project/import-machine";
import { createProject, type RetiredPairProject } from "../project/projects";
import type { ShareLinkRecord } from "../store/storage";
import {
  createWorkspaceDialogsMachine,
  getAskedRelease,
  getImportReport,
  type WorkspaceDialogsDependencies,
} from "./workspace-dialogs-machine";

const shareLink: ShareLinkRecord = { linkId: "link", publishedAt: "2026-01-01T00:00:00.000Z" };

function makeProject(name = "Bank transfers") {
  return createProject(name, { dialect: "sqlite" });
}

function makeRetired(id: string): RetiredPairProject {
  return { id, name: id, manifest: {}, releases: [], record: {} };
}

function makeImport(id: string): QueuedRetiredImport {
  return {
    id,
    name: id,
    manifest: {},
    releases: [],
    community: undefined,
    shareLink: undefined,
    opens: false,
  };
}

function startDialogs(overrides: Partial<WorkspaceDialogsDependencies> = {}) {
  const dependencies: WorkspaceDialogsDependencies = {
    renameProject: vi.fn(async () => {}),
    deleteProjects: vi.fn(async () => {}),
    findShareLinks: vi.fn(async () => new Map()),
    writeExport: vi.fn(),
    ...overrides,
  };
  const actor = createActor(createWorkspaceDialogsMachine(dependencies)).start();

  return { actor, dependencies };
}

describe("createWorkspaceDialogsMachine", () => {
  it("should ignore an export lookup that answers after another dialog opened", async () => {
    const lookup = Promise.withResolvers<ReadonlyMap<string, ShareLinkRecord>>();
    const { actor, dependencies } = startDialogs({ findShareLinks: () => lookup.promise });
    const project = makeProject();

    actor.send({ type: "export.start", projects: [project] });
    actor.send({ type: "rename.open", project });
    lookup.resolve(new Map([[project.id, shareLink]]));
    await lookup.promise;

    expect(actor.getSnapshot().matches({ dialogs: "rename" })).toBe(true);
    expect(dependencies.writeExport).not.toHaveBeenCalled();
  });

  it("should keep a failed rename's error in the rename dialog and start the next dialog without it", async () => {
    const { actor } = startDialogs({
      renameProject: async () => {
        throw new Error("The store is full.");
      },
    });

    actor.send({ type: "rename.open", project: makeProject() });
    actor.send({ type: "dialog.submit" });
    await waitFor(actor, (snapshot) => snapshot.matches({ dialogs: { rename: "editing" } }));
    const failed = actor.getSnapshot().context.error;
    actor.send({ type: "dialog.close" });
    actor.send({ type: "delete.open", projects: [makeProject()] });

    expect(failed).toBe("The store is full.");
    expect(actor.getSnapshot().context.error).toBe("");
  });

  it("should refuse a second submit while the rename saves", async () => {
    const saved = Promise.withResolvers<void>();
    const renameProject = vi.fn(() => saved.promise);
    const { actor } = startDialogs({ renameProject });

    actor.send({ type: "rename.open", project: makeProject("Old") });
    actor.send({ type: "name.change", name: "New" });
    actor.send({ type: "dialog.submit" });
    actor.send({ type: "dialog.submit" });
    saved.resolve();
    await waitFor(actor, (snapshot) => snapshot.matches({ dialogs: "closed" }));

    expect(renameProject).toHaveBeenCalledOnce();
    expect(renameProject).toHaveBeenCalledWith(expect.objectContaining({ name: "New" }));
  });

  it("should write an export with no shared link at once, and ask about share links otherwise", async () => {
    const plain = makeProject("Plain");
    const shared = makeProject("Shared");
    const { actor, dependencies } = startDialogs({
      findShareLinks: async ({ projects }) =>
        new Map(projects.filter((project) => project.id === shared.id).map((project) => [project.id, shareLink])),
    });

    actor.send({ type: "export.start", projects: [plain] });
    await waitFor(actor, (snapshot) => snapshot.matches({ dialogs: "closed" }));
    actor.send({ type: "export.start", projects: [shared], filename: "shared.json" });
    await waitFor(actor, (snapshot) => snapshot.matches({ dialogs: "exportConfirm" }));
    actor.send({ type: "links.toggle", include: true });
    actor.send({ type: "dialog.submit" });

    expect(dependencies.writeExport).toHaveBeenNthCalledWith(1, expect.objectContaining({ includeLinks: false }));
    expect(dependencies.writeExport).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        filename: "shared.json",
        includeLinks: true,
        links: new Map([[shared.id, shareLink]]),
      }),
    );
  });

  it("should not delete without a project", () => {
    const { actor } = startDialogs();

    actor.send({ type: "delete.open", projects: [] });

    expect(actor.getSnapshot().matches({ dialogs: "closed" })).toBe(true);
  });
});

describe("getAskedRelease", () => {
  it("should wait for the workspace, then ask about stored projects before imports", () => {
    const { actor } = startDialogs();

    actor.send({ type: "import.done", added: 0, retired: [makeImport("imported")], skipped: [], releaseNotes: [] });
    const whileLoading = getAskedRelease(actor.getSnapshot(), []);
    actor.send({ type: "releases.load", stored: [makeRetired("stored")] });
    const first = getAskedRelease(actor.getSnapshot(), []);
    actor.send({ type: "release.answer", id: "stored", answer: "chosen" });

    expect(whileLoading).toBeUndefined();
    expect(first?.project.id).toBe("stored");
    expect(getAskedRelease(actor.getSnapshot(), [])?.project.id).toBe("imported");
  });

  it("should skip a stored project another tab already moved to a release", () => {
    const { actor } = startDialogs();
    const moved = makeProject();

    actor.send({ type: "releases.load", stored: [makeRetired(moved.id), makeRetired("other")] });

    expect(getAskedRelease(actor.getSnapshot(), [moved])?.project.id).toBe("other");
  });
});

describe("getImportReport", () => {
  it("should move each imported project from waiting to added or left out as the chooser is answered", () => {
    const { actor } = startDialogs();

    actor.send({ type: "releases.load", stored: [] });
    actor.send({
      type: "import.done",
      added: 2,
      retired: [makeImport("first"), makeImport("second")],
      skipped: ["broken.json could not be read."],
      releaseNotes: [],
    });
    const asked = getImportReport(actor.getSnapshot());
    actor.send({ type: "release.answer", id: "first", answer: "chosen" });
    actor.send({ type: "release.answer", id: "second", answer: "later" });

    expect(asked).toEqual({
      added: 2,
      pending: 2,
      declined: 0,
      skipped: ["broken.json could not be read."],
      releaseNotes: [],
    });
    expect(getImportReport(actor.getSnapshot())).toEqual({
      added: 3,
      pending: 0,
      declined: 1,
      skipped: ["broken.json could not be read."],
      releaseNotes: [],
    });
  });

  it("should add an import to the report while earlier ones wait, and start a new report otherwise", () => {
    const { actor } = startDialogs();

    actor.send({ type: "releases.load", stored: [] });
    actor.send({ type: "import.done", added: 1, retired: [makeImport("waiting")], skipped: [], releaseNotes: [] });
    actor.send({ type: "import.done", added: 1, retired: [], skipped: [], releaseNotes: [] });
    const whileWaiting = getImportReport(actor.getSnapshot());
    actor.send({ type: "release.answer", id: "waiting", answer: "later" });
    actor.send({ type: "import.done", added: 1, retired: [], skipped: [], releaseNotes: [] });

    expect(whileWaiting).toMatchObject({ added: 2, pending: 1 });
    expect(getImportReport(actor.getSnapshot())).toMatchObject({ added: 1, pending: 0, declined: 0 });
  });

  it("should count a project still waiting from before the banner was dismissed", () => {
    const { actor } = startDialogs();

    actor.send({ type: "import.done", added: 0, retired: [makeImport("early")], skipped: [], releaseNotes: [] });
    actor.send({ type: "import_report.dismiss" });
    actor.send({ type: "import.done", added: 0, retired: [makeImport("late")], skipped: [], releaseNotes: [] });
    actor.send({ type: "releases.load", stored: [] });
    actor.send({ type: "release.answer", id: "early", answer: "chosen" });

    expect(getImportReport(actor.getSnapshot())).toMatchObject({ added: 1, pending: 1 });
  });

  it("should leave the report alone when a stored project is answered", () => {
    const { actor } = startDialogs();

    actor.send({ type: "releases.load", stored: [makeRetired("stored")] });
    actor.send({ type: "import.done", added: 1, retired: [], skipped: [], releaseNotes: [] });
    actor.send({ type: "release.answer", id: "stored", answer: "later" });

    expect(getImportReport(actor.getSnapshot())).toMatchObject({ added: 1, declined: 0 });
  });
});
