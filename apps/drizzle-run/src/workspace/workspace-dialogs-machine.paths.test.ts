import {
  type ActorOutcome,
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  type MachinePath,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { describe, expect, it, vi } from "vitest";
import { createActor, type SnapshotFrom } from "xstate";

import type { QueuedRetiredImport } from "../project/import-machine";
import { createProject, type RetiredPairProject } from "../project/projects";
import type { ShareLinkRecord } from "../store/storage";
import {
  createWorkspaceDialogsMachine,
  getImportReport,
  type WorkspaceDialogsDependencies,
} from "./workspace-dialogs-machine";

function makeDependencies(): WorkspaceDialogsDependencies {
  return {
    renameProject: vi.fn(async () => {}),
    deleteProjects: vi.fn(async () => {}),
    findShareLinks: vi.fn(async () => new Map()),
    writeExport: vi.fn(),
  };
}

const workspaceDialogsMachine = createWorkspaceDialogsMachine(makeDependencies());
const project = createProject("Bank transfers", { dialect: "sqlite" });
const shareLink: ShareLinkRecord = { linkId: "link", publishedAt: "2026-01-01T00:00:00.000Z" };
const storedRelease: RetiredPairProject = { id: "stored", name: "stored", manifest: {}, releases: [], record: {} };
const importedRelease: QueuedRetiredImport = {
  id: "imported",
  name: "imported",
  manifest: {},
  releases: [],
  community: undefined,
  shareLink: undefined,
  opens: false,
};

const saveOutcome: ActorOutcome<void> = { outputs: [undefined], error: new Error("The store refused the write.") };
class ShareLinks extends Map<string, ShareLinkRecord> {
  toJSON() {
    return [...this.keys()];
  }
}

const noLinks = new ShareLinks();
const oneLink = new ShareLinks([[project.id, shareLink]]);
const findShareLinksOutcome: ActorOutcome<ReadonlyMap<string, ShareLinkRecord>> = {
  outputs: [noLinks, oneLink],
  error: new Error("The links could not be read."),
};
const outcomes = {
  renameProject: saveOutcome,
  deleteProjects: saveOutcome,
  findShareLinks: findShareLinksOutcome,
};

const deleteOneProject = { type: "delete.open", projects: [project] } as const;
const deleteNoProject = { type: "delete.open", projects: [] } as const;
const includeLinks = { type: "links.toggle", include: true } as const;
const leaveOutLinks = { type: "links.toggle", include: false } as const;
const importWithoutRetired = { type: "import.done", added: 0, retired: [], skipped: [], releaseNotes: [] } as const;
const importWithRetired = {
  type: "import.done",
  added: 1,
  retired: [importedRelease],
  skipped: [],
  releaseNotes: [],
} as const;
const loadStoredRelease = { type: "releases.load", stored: [storedRelease] } as const;
const loadNoRelease = { type: "releases.load", stored: [] } as const;
const answerStored = { type: "release.answer", id: storedRelease.id, answer: "chosen" } as const;
const answerImported = { type: "release.answer", id: importedRelease.id, answer: "chosen" } as const;
const answerUnknown = { type: "release.answer", id: "unknown", answer: "chosen" } as const;
const declineImported = { type: "release.answer", id: importedRelease.id, answer: "later" } as const;
const eventLabels = new Map<object, string>([
  [deleteOneProject, "delete.open with a project"],
  [deleteNoProject, "delete.open without a project"],
  [includeLinks, "links.toggle on"],
  [leaveOutLinks, "links.toggle off"],
  [importWithoutRetired, "import.done without a retired project"],
  [importWithRetired, "import.done with a retired project"],
  [loadStoredRelease, "releases.load with a stored project"],
  [loadNoRelease, "releases.load without a stored project"],
  [answerStored, "release.answer for the stored project"],
  [answerImported, "release.answer for the imported project"],
  [answerUnknown, "release.answer for an unknown project"],
  [declineImported, "release.answer declining the imported project"],
]);

function describeEvent(event: { type: string; output?: unknown }) {
  if (event.output === noLinks) {
    return "done(findShareLinks) without links";
  }

  if (event.output === oneLink) {
    return "done(findShareLinks) with a link";
  }

  return eventLabels.get(event);
}

type WorkspaceDialogsSnapshot = SnapshotFrom<typeof workspaceDialogsMachine>;

function toDialogsModelState(snapshot: WorkspaceDialogsSnapshot) {
  return {
    value: snapshot.value,
    error: snapshot.context.error !== "",
    includeLinks: snapshot.context.includeLinks,
    shared: snapshot.context.sharedCount > 0,
  };
}

function toReleaseChooserModelState(snapshot: WorkspaceDialogsSnapshot) {
  const report = getImportReport(snapshot);

  return {
    value: snapshot.value,
    releases: [...new Set(snapshot.context.releases.map((release) => `${release.kind}:${release.project.id}`))],
    report:
      report === null
        ? "none"
        : [report.pending > 0 ? "pending" : "", report.declined > 0 ? "declined" : ""].filter(Boolean).join("+") ||
          "added",
  };
}

function startWorkspaceDialogs() {
  const settler = createActorSettler();
  const machine = createWorkspaceDialogsMachine(makeDependencies()).provide({
    actors: {
      renameProject: settler.fromOutcome(outcomes.renameProject),
      deleteProjects: settler.fromOutcome(outcomes.deleteProjects),
      findShareLinks: settler.fromOutcome(outcomes.findShareLinks),
    },
  });

  return { actor: createActor(machine).start(), settler };
}

const dialogsPaths = getMachinePaths(workspaceDialogsMachine, {
  toModelState: toDialogsModelState,
  describeEvent,
  events: (snapshot) => [
    { type: "create.open" },
    { type: "rename.open", project },
    deleteOneProject,
    deleteNoProject,
    { type: "export.start", projects: [project] },
    { type: "name.change", name: "Renamed" },
    includeLinks,
    leaveOutLinks,
    { type: "dialog.submit" },
    { type: "dialog.close" },
    importWithoutRetired,
    ...getSettleEvents(snapshot, outcomes),
  ],
});

const releaseChooserPaths = getMachinePaths(workspaceDialogsMachine, {
  toModelState: toReleaseChooserModelState,
  describeEvent,
  events: () => [
    importWithRetired,
    loadStoredRelease,
    loadNoRelease,
    answerStored,
    answerImported,
    answerUnknown,
    declineImported,
    { type: "import_report.dismiss" },
  ],
});

function describePaths(
  name: string,
  paths: readonly MachinePath[],
  toModelState: (snapshot: WorkspaceDialogsSnapshot) => unknown,
) {
  describe(`${name} paths`, () => {
    it("should take the same transitions", () => {
      expect(toTransitionTable(paths)).toMatchSnapshot();
    });

    for (const path of paths) {
      it(`should take ${path.description}`, async () => {
        const { actor, settler } = startWorkspaceDialogs();

        await expect(replayMachinePath(path, { actor, settler, toModelState })).resolves.toBeUndefined();
        actor.stop();
      });
    }
  });
}

describe("workspace dialogs machine paths", () => {
  describePaths("dialogs", dialogsPaths, toDialogsModelState);
  describePaths("release chooser", releaseChooserPaths, toReleaseChooserModelState);
});
