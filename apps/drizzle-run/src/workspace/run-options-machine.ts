import type { QueryPlansSettings } from "@drizzle-run/core/contracts";
import { assign, setup } from "xstate";

import { declareType } from "../lib/declare-type";
import { QUERY_PLANS_OFF, toQueryPlansSettings, type QueryPlansFlag } from "../ui/query-plans";

/** What a project view's next run captures besides its output: Debug traces and Query plans. */
export interface RunOptions {
  debug: boolean;
  queryPlans: QueryPlansFlag;
}

/** Turns Debug traces on or off, or sets the Query plans flag. */
export type RunOptionsEvent =
  | { type: "debug.change"; debug: boolean }
  | { type: "queryPlans.change"; queryPlans: QueryPlansFlag };

/** The run options as a run submits them: no Query plans settings while the flag is off. */
export interface RunSubmissionOptions {
  debug: boolean;
  queryPlans: QueryPlansSettings | undefined;
}

/** Both options start off, as when the user opens a project. */
export const RUN_OPTIONS_OFF: RunOptions = { debug: false, queryPlans: QUERY_PLANS_OFF };

/**
 * Run options machine
 *
 * Holds Debug traces and Query plans for one open project, one-version or side by side. Both stay off until turned
 * on and reset when the user leaves the project, since the view's actor goes with it. An actor rather than React
 * state because the AI chat may set Query plans and run at once: the run reads the snapshot before a render could
 * read the new state.
 */
export const runOptionsMachine = setup({
  types: {
    context: declareType<RunOptions>(),
    events: declareType<RunOptionsEvent>(),
  },
}).createMachine({
  id: "runOptions",
  context: RUN_OPTIONS_OFF,
  on: {
    "debug.change": { actions: assign({ debug: ({ event }) => event.debug }) },
    "queryPlans.change": { actions: assign({ queryPlans: ({ event }) => event.queryPlans }) },
  },
});

/** Converts the run options to what a run submits. */
export function toRunSubmissionOptions(options: RunOptions): RunSubmissionOptions {
  return { debug: options.debug, queryPlans: toQueryPlansSettings(options.queryPlans) };
}
