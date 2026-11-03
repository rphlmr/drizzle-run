import { useSyncExternalStore } from "react";

import { createStoredSwitch } from "./stored-switch";

const formatOnRunSwitch = createStoredSwitch({ key: "format-on-run", offValue: "off" });

/** Whether Run formats the code first, read when Run is pressed. */
export const isFormatOnRun = formatOnRunSwitch.readCurrent;

/** Saves whether Run formats the code first and tells the menu on the page. */
export const applyFormatOnRun = formatOnRunSwitch.apply;

/** Whether Run formats the code first, updated as this page or another tab changes it. */
export function useFormatOnRun(): boolean {
  return useSyncExternalStore(formatOnRunSwitch.subscribe, formatOnRunSwitch.readCurrent, () => true);
}
