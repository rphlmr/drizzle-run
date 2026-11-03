import { describe, expect, it } from "vitest";
import { createActor } from "xstate";

import {
  createEditorCommandsMachine,
  type EditorCommand,
  type EditorHighlightCommand,
} from "./editor-commands-machine";

function makeHighlight(overrides: Partial<EditorHighlightCommand> = {}): EditorHighlightCommand {
  return { kind: "highlight", version: 1, file: "query.ts", lines: [3, 5], open: true, reveal: false, ...overrides };
}

function startQueue() {
  const applied: { session: string; command: EditorCommand }[] = [];
  const actor = createActor(
    createEditorCommandsMachine<string>({ apply: (session, command) => applied.push({ session, command }) }),
  ).start();

  return { actor, applied };
}

describe("createEditorCommandsMachine", () => {
  it("should hold commands until the editor is ready, then carry them out in order", () => {
    const { actor, applied } = startQueue();
    const files: EditorCommand = { kind: "files", version: 1, files: { "query.ts": "select" } };

    actor.send({ type: "command.add", command: files });
    actor.send({ type: "command.add", command: makeHighlight() });
    expect(applied).toEqual([]);

    actor.send({ type: "editor.attach", session: "editor" });

    expect(applied.map(({ command }) => command.kind)).toEqual(["files", "highlight"]);
  });

  it("should keep only the newest waiting command of each kind and refuse one seen before", () => {
    const { actor, applied } = startQueue();

    actor.send({ type: "command.add", command: makeHighlight({ version: 1, file: "schema.ts" }) });
    actor.send({ type: "command.add", command: makeHighlight({ version: 2, file: "query.ts" }) });
    actor.send({ type: "editor.attach", session: "editor" });
    actor.send({ type: "command.add", command: makeHighlight({ version: 2, file: "seed.ts" }) });

    expect(applied.map(({ command }) => command.kind === "highlight" && command.file)).toEqual(["query.ts"]);
  });

  it("should mark without opening the file once the learner chose another file first", () => {
    const { actor, applied } = startQueue();

    actor.send({ type: "command.add", command: makeHighlight() });
    actor.send({ type: "file.choose" });
    actor.send({ type: "editor.attach", session: "editor" });

    expect(applied[0]?.command).toMatchObject({ kind: "highlight", open: false });
  });

  it("should carry out a command at once on a ready editor, and wait again once the editor goes", () => {
    const { actor, applied } = startQueue();
    actor.send({ type: "editor.attach", session: "first" });

    actor.send({ type: "command.add", command: makeHighlight({ version: 1 }) });
    actor.send({ type: "editor.detach" });
    actor.send({ type: "command.add", command: makeHighlight({ version: 2 }) });
    actor.send({ type: "editor.attach", session: "second" });

    expect(applied.map(({ session, command }) => [session, command.version])).toEqual([
      ["first", 1],
      ["second", 2],
    ]);
  });
});
