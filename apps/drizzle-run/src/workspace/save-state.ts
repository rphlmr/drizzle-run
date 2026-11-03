/** Where a workspace's edits are kept, as the status bar reports it. */
export type SaveState =
  | "saved"
  | "saving"
  | "save_error"
  | "unsaved"
  | "temporary"
  | "guided_read_only"
  | "side_by_side_step"
  | "read_only";

/** The local store's own save states, the ones a stored project goes through. */
export type StoreSaveState = Extract<SaveState, "saved" | "saving" | "save_error" | "unsaved">;

/** Whether a save state is the local store's own, so the project is a stored one. */
export function isStoreSaveState(saveState: SaveState): saveState is StoreSaveState {
  return saveState === "saved" || saveState === "saving" || saveState === "save_error" || saveState === "unsaved";
}

/** The status bar text of each save state. */
export const saveStateLabels = {
  saved: "Saved in this browser",
  saving: "Saving…",
  save_error: "Unsaved · storage error",
  unsaved: "Unsaved changes",
  temporary: "Temporary copy, not saved",
  guided_read_only: "Guided example, read-only",
  side_by_side_step: "Side-by-side step, not saved",
  read_only: "Read only",
} as const satisfies Record<SaveState, string>;

/** The phone switcher's subtitle beside the dialect, as in "PostgreSQL · saved". */
export const storeSaveStateShortLabels = {
  saved: "saved",
  saving: "saving…",
  save_error: "not saved",
  unsaved: "unsaved changes",
} as const satisfies Record<StoreSaveState, string>;

/**
 * Whether unloading the page would lose edits
 *
 * True for an edited copy nothing saves, and for a stored project whose last edits have not reached the store. A
 * clean temporary or read-only copy loses nothing.
 */
export function shouldWarnOnUnload({ saveState, unsavedCopy }: { saveState: SaveState; unsavedCopy: boolean }) {
  return unsavedCopy || saveState === "saving" || saveState === "save_error" || saveState === "unsaved";
}
