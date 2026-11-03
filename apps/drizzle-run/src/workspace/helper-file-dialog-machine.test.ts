import { describe, expect, it } from "vitest";
import { createActor } from "xstate";

import { getHelperFileAction, helperFileDialogMachine } from "./helper-file-dialog-machine";

function startDialog() {
  return createActor(helperFileDialogMachine).start();
}

describe("helperFileDialogMachine", () => {
  it("should start closed", () => {
    const dialog = startDialog();

    expect(getHelperFileAction(dialog.getSnapshot())).toBeNull();
    dialog.stop();
  });

  it("should open a new file with an empty path and no error", () => {
    const dialog = startDialog();

    dialog.send({ type: "rename.open", path: "helpers.ts" });
    dialog.send({ type: "submit.fail", error: "Entry filenames are fixed." });
    dialog.send({ type: "dialog.close" });
    dialog.send({ type: "create.open" });

    expect(getHelperFileAction(dialog.getSnapshot())).toBe("create");
    expect(dialog.getSnapshot().context).toEqual({ filename: "", error: "" });
    dialog.stop();
  });

  it("should open a rename on the open file's path", () => {
    const dialog = startDialog();

    dialog.send({ type: "rename.open", path: "helpers.ts" });

    expect(getHelperFileAction(dialog.getSnapshot())).toBe("rename");
    expect(dialog.getSnapshot().context.filename).toBe("helpers.ts");
    dialog.stop();
  });

  it("should keep the typed path and clear the error when it opens a delete", () => {
    const dialog = startDialog();

    dialog.send({ type: "create.open" });
    dialog.send({ type: "filename.change", filename: "utils.ts" });
    dialog.send({ type: "submit.fail", error: "Pick another path." });
    dialog.send({ type: "delete.open" });

    expect(getHelperFileAction(dialog.getSnapshot())).toBe("delete");
    expect(dialog.getSnapshot().context).toEqual({ filename: "utils.ts", error: "" });
    dialog.stop();
  });

  it("should show a failed submit's error until the dialog closes", () => {
    const dialog = startDialog();

    dialog.send({ type: "create.open" });
    dialog.send({ type: "filename.change", filename: "../outside.ts" });
    dialog.send({ type: "submit.fail", error: "Use a relative path." });

    expect(dialog.getSnapshot().context.error).toBe("Use a relative path.");

    dialog.send({ type: "dialog.close" });

    expect(getHelperFileAction(dialog.getSnapshot())).toBeNull();
    dialog.stop();
  });

  it("should ignore edits while closed or deleting", () => {
    const dialog = startDialog();

    dialog.send({ type: "filename.change", filename: "ignored.ts" });
    expect(dialog.getSnapshot().context.filename).toBe("");

    dialog.send({ type: "delete.open" });
    dialog.send({ type: "filename.change", filename: "ignored.ts" });

    expect(dialog.getSnapshot().context.filename).toBe("");
    dialog.stop();
  });
});
