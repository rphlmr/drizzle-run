import { useActorRef, useSelector } from "@xstate/react";
import { useMemo } from "react";

import { toQueryPlansSettings, type QueryPlansFlag } from "../ui/query-plans";
import { runOptionsMachine, toRunSubmissionOptions, type RunSubmissionOptions } from "./run-options-machine";

/**
 * Debug traces and Query plans of the open project
 *
 * Renders read `debug`, `queryPlans` and `plansSettings`; a run reads `read()` when it starts, so a change made just
 * before it, such as the AI chat's, is never missed.
 */
export function useRunOptions() {
  const actor = useActorRef(runOptionsMachine);
  const debug = useSelector(actor, (snapshot) => snapshot.context.debug);
  const queryPlans = useSelector(actor, (snapshot) => snapshot.context.queryPlans);
  const plansSettings = useMemo(() => toQueryPlansSettings(queryPlans), [queryPlans]);
  const controls = useMemo(() => {
    const setQueryPlans = (next: QueryPlansFlag) => actor.send({ type: "queryPlans.change", queryPlans: next });

    return {
      setDebug: (next: boolean) => actor.send({ type: "debug.change", debug: next }),
      setQueryPlans,
      /** The options as a run starting now submits them. */
      read: (): RunSubmissionOptions => toRunSubmissionOptions(actor.getSnapshot().context),
      /** The Query plans flag as the AI chat tools read and set it. */
      connectQueryPlans: {
        get: (): QueryPlansFlag => actor.getSnapshot().context.queryPlans,
        set: setQueryPlans,
      },
    };
  }, [actor]);

  return {
    debug,
    queryPlans,
    /** The Query plans settings the next run submits, undefined while off. */
    plansSettings,
    ...controls,
  };
}

/** The open project's run options and their setters. */
export type RunOptionsControls = ReturnType<typeof useRunOptions>;
