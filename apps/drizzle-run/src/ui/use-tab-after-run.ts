import { useRunSettled } from "@drizzle-run/react";

import { getOfferedTab, getTabAfterRun, type OutputTab } from "./output-tab";

/** Options of `useTabAfterRun`. */
export interface UseTabAfterRunOptions {
  /** The output's tab now. */
  tab: OutputTab;
  /** The views the output offers, such as an embed's; every view by default. */
  views?: readonly OutputTab[];
  onTabChange: (tab: OutputTab) => void;
}

/**
 * Move the output to its tab after each run
 *
 * Listens to the closest `RunProvider`'s run: a failed run opens Problems, a successful one leaves Problems for
 * Results, and a cancelled one changes nothing (see `getTabAfterRun`). A side-by-side project calls it once per side.
 */
export function useTabAfterRun({ tab, views, onTabChange }: UseTabAfterRunOptions): void {
  useRunSettled(({ opens }) => {
    const next = getTabAfterRun(opens, tab);

    onTabChange(views === undefined ? next : getOfferedTab(next, views));
  });
}
