import {
  type ActorOutcome,
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { describe, expect, it } from "vitest";
import { createActor, type SnapshotFrom } from "xstate";

import type { ShareLinkRecord } from "../store/storage";
import { PROJECT_IMPORT_LIMIT, projectImportMachine, type ParsedProjectFile } from "./import-machine";
import { createProject } from "./projects";

const link: ShareLinkRecord = {
  linkId: "6f1d2c3b-4a5e-4f60-8a7b-1c2d3e4f5a6b",
  publishedAt: "2026-10-15T00:00:00.000Z",
};
const project = createProject("Bank transfers", { dialect: "postgresql" });
const fileWithoutKey: ParsedProjectFile = {
  parsed: [{ project, shareLink: undefined }],
  skipped: [],
  retired: [],
  opens: true,
};
const fileWithKey: ParsedProjectFile = {
  parsed: [{ project, shareLink: link }],
  skipped: [],
  retired: [],
  opens: true,
};
const writeOutcome: ActorOutcome<void> = { outputs: [undefined], error: new Error("The store refused the write.") };
const outcomes = {
  read: { outputs: [JSON.stringify(project)], error: new Error("The file could not be read.") },
  parse: { outputs: [fileWithoutKey, fileWithKey], error: new Error("This file is not a project.") },
  restoreShareKey: writeOutcome,
  save: writeOutcome,
};

class ProjectFile extends File {
  toJSON() {
    return { name: this.name, size: this.size };
  }
}

const pickFile = {
  type: "file.pick",
  file: new ProjectFile([JSON.stringify(project)], "project.json", { type: "application/json" }),
} as const;
const pickTooLargeFile = {
  type: "file.pick",
  file: new ProjectFile([new Uint8Array(PROJECT_IMPORT_LIMIT + 1)], "huge.json", { type: "application/json" }),
} as const;
const eventLabels = new Map<unknown, string>([
  [pickFile, "file.pick"],
  [pickTooLargeFile, "file.pick too large"],
]);

function describeEvent(event: { type: string; output?: unknown }) {
  if (event.output === fileWithoutKey) {
    return "done(parse) without a share link";
  }

  if (event.output === fileWithKey) {
    return "done(parse) with a share link";
  }

  return eventLabels.get(event);
}

function toModelState(snapshot: SnapshotFrom<typeof projectImportMachine>) {
  return { value: snapshot.value, file: snapshot.context.file !== undefined, error: snapshot.context.error !== "" };
}

function startProjectImport() {
  const settler = createActorSettler();
  const machine = projectImportMachine.provide({
    actors: {
      read: settler.fromOutcome(outcomes.read),
      parse: settler.fromOutcome(outcomes.parse),
      restoreShareKey: settler.fromOutcome(outcomes.restoreShareKey),
      save: settler.fromOutcome(outcomes.save),
    },
  });

  return { actor: createActor(machine).start(), settler };
}

const paths = getMachinePaths(projectImportMachine, {
  toModelState,
  describeEvent,
  events: (snapshot) => [
    pickFile,
    pickTooLargeFile,
    { type: "import.retry" },
    { type: "import.dismiss" },
    ...getSettleEvents(snapshot, outcomes),
  ],
});

describe("project import machine paths", () => {
  it("should take the same transitions", () => {
    expect(toTransitionTable(paths)).toMatchSnapshot();
  });

  for (const path of paths) {
    it(`should take ${path.description}`, async () => {
      const { actor, settler } = startProjectImport();

      await expect(replayMachinePath(path, { actor, settler, toModelState })).resolves.toBeUndefined();
      actor.stop();
    });
  }
});
