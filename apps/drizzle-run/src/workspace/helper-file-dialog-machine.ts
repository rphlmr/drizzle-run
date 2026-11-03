import { assign, setup, type SnapshotFrom } from "xstate";

import { declareType } from "../lib/declare-type";

/** What the helper file dialog does: add a file, rename the open one, or delete it. */
export type HelperFileAction = "create" | "rename" | "delete";

interface HelperFileDialogContext {
  /** The path typed in the dialog: empty for a new file, the open file's path to rename it. */
  filename: string;
  /** Why the last submit failed, shown under the field; empty otherwise. */
  error: string;
}

/** Opens the dialog for an action, edits its path, reports a failed submit, or closes it. */
export type HelperFileDialogEvent =
  | { type: "create.open" }
  | { type: "rename.open"; path: string }
  | { type: "delete.open" }
  | { type: "filename.change"; filename: string }
  | { type: "submit.fail"; error: string }
  | { type: "dialog.close" };

/**
 * Helper file dialog machine
 *
 * The dialog behind "+" and the file menu's "Rename file…" and "Delete file…": closed, or open on one action at a
 * time. Opening clears the last error; a delete keeps the typed path, which it does not use. The view applies the
 * submit itself and sends `submit.fail` with its error, or `dialog.close` once it succeeded.
 */
export const helperFileDialogMachine = setup({
  types: {
    context: declareType<HelperFileDialogContext>(),
    events: declareType<HelperFileDialogEvent>(),
  },
}).createMachine({
  id: "helperFileDialog",
  initial: "closed",
  context: { filename: "", error: "" },
  on: {
    "create.open": { target: ".create", actions: assign({ filename: "", error: "" }) },
    "rename.open": { target: ".rename", actions: assign({ filename: ({ event }) => event.path, error: "" }) },
    "delete.open": { target: ".delete", actions: assign({ error: "" }) },
  },
  states: {
    closed: {},
    create: {
      on: {
        "filename.change": { actions: assign({ filename: ({ event }) => event.filename }) },
        "submit.fail": { actions: assign({ error: ({ event }) => event.error }) },
        "dialog.close": "closed",
      },
    },
    rename: {
      on: {
        "filename.change": { actions: assign({ filename: ({ event }) => event.filename }) },
        "submit.fail": { actions: assign({ error: ({ event }) => event.error }) },
        "dialog.close": "closed",
      },
    },
    delete: {
      on: {
        "submit.fail": { actions: assign({ error: ({ event }) => event.error }) },
        "dialog.close": "closed",
      },
    },
  },
});

/** The action the open dialog performs, or null while it is closed. */
export function getHelperFileAction(snapshot: SnapshotFrom<typeof helperFileDialogMachine>): HelperFileAction | null {
  if (snapshot.matches("create")) {
    return "create";
  }

  if (snapshot.matches("rename")) {
    return "rename";
  }

  return snapshot.matches("delete") ? "delete" : null;
}
