import { createActorSettler, getMachinePaths, replayMachinePath, toTransitionTable } from "@drizzle-run/machine-paths";
import { describe, expect, it, vi } from "vitest";
import { createActor, type SnapshotFrom } from "xstate";

import { createEditorCommandsMachine, type EditorCommand } from "./editor-commands-machine";

const editorCommandsMachine = createEditorCommandsMachine<string>({ apply: vi.fn() });

function makeCommand(kind: EditorCommand["kind"], version: number): EditorCommand {
  return kind === "files"
    ? { kind, version, files: { "query.ts": "select" } }
    : { kind, version, file: "query.ts", lines: [3, 5], open: true, reveal: false };
}

const addFirstFiles = { type: "command.add", command: makeCommand("files", 1) } as const;
const addSecondFiles = { type: "command.add", command: makeCommand("files", 2) } as const;
const addFirstHighlight = { type: "command.add", command: makeCommand("highlight", 1) } as const;
const addSecondHighlight = { type: "command.add", command: makeCommand("highlight", 2) } as const;
const eventLabels = new Map<object, string>([
  [addFirstFiles, "command.add files version 1"],
  [addSecondFiles, "command.add files version 2"],
  [addFirstHighlight, "command.add highlight version 1"],
  [addSecondHighlight, "command.add highlight version 2"],
]);

function toModelState(snapshot: SnapshotFrom<typeof editorCommandsMachine>) {
  return {
    value: snapshot.value,
    versions: snapshot.context.versions,
    queue: snapshot.context.queue.map((command) =>
      command.kind === "highlight" ? `highlight open=${command.open}` : command.kind,
    ),
  };
}

const paths = getMachinePaths(editorCommandsMachine, {
  toModelState,
  describeEvent: (event) => eventLabels.get(event),
  events: () => [
    { type: "editor.attach", session: "editor" },
    { type: "editor.detach" },
    addFirstFiles,
    addSecondFiles,
    addFirstHighlight,
    addSecondHighlight,
    { type: "file.choose" },
  ],
});

describe("editor commands machine paths", () => {
  it("should take the same transitions", () => {
    expect(toTransitionTable(paths)).toMatchSnapshot();
  });

  for (const path of paths) {
    it(`should take ${path.description}`, async () => {
      const actor = createActor(createEditorCommandsMachine<string>({ apply: vi.fn() })).start();

      await expect(
        replayMachinePath(path, { actor, settler: createActorSettler(), toModelState }),
      ).resolves.toBeUndefined();
      actor.stop();
    });
  }
});
