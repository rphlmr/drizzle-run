import { useSyncExternalStore } from "react";

import { createStoredSwitch } from "./stored-switch";

const runNotesSwitch = createStoredSwitch({ key: "run-notes", offValue: "hidden" });

/** Saves whether runs leave notes in the code and tells every editor on the page. */
export const applyRunNotesShown = runNotesSwitch.apply;

/** Whether runs leave their notes in the code, updated as this page or another tab changes it. */
export function useRunNotesShown(): boolean {
  return useSyncExternalStore(runNotesSwitch.subscribe, runNotesSwitch.readCurrent, () => true);
}
