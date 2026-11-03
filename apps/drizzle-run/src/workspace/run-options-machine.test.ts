import { describe, expect, it } from "vitest";
import { createActor } from "xstate";

import { QUERY_PLANS_OFF, type QueryPlansFlag } from "../ui/query-plans";
import { RUN_OPTIONS_OFF, runOptionsMachine, toRunSubmissionOptions, type RunOptions } from "./run-options-machine";

function makeQueryPlans({ on = true, size = "10k", measureRealTime = false }: Partial<QueryPlansFlag> = {}) {
  return { on, size, measureRealTime } satisfies QueryPlansFlag;
}

function makeRunOptions({ debug = false, queryPlans = QUERY_PLANS_OFF }: Partial<RunOptions> = {}): RunOptions {
  return { debug, queryPlans };
}

describe("runOptionsMachine", () => {
  it("should start with Debug and Query plans off", () => {
    const actor = createActor(runOptionsMachine).start();

    expect(actor.getSnapshot().context).toEqual(RUN_OPTIONS_OFF);
    actor.stop();
  });

  it("should turn Debug on and off without touching Query plans", () => {
    const actor = createActor(runOptionsMachine).start();

    actor.send({ type: "debug.change", debug: true });
    expect(actor.getSnapshot().context).toEqual({ debug: true, queryPlans: QUERY_PLANS_OFF });

    actor.send({ type: "debug.change", debug: false });
    expect(actor.getSnapshot().context).toEqual(RUN_OPTIONS_OFF);
    actor.stop();
  });

  it("should give the new Query plans flag to a read right after the change", () => {
    const actor = createActor(runOptionsMachine).start();
    const queryPlans = makeQueryPlans({ size: "100k" });

    actor.send({ type: "queryPlans.change", queryPlans });

    expect(actor.getSnapshot().context).toEqual({ debug: false, queryPlans });
    actor.stop();
  });

  it("should start off again in a new actor, as when the user leaves the project", () => {
    const first = createActor(runOptionsMachine).start();

    first.send({ type: "debug.change", debug: true });
    first.send({ type: "queryPlans.change", queryPlans: makeQueryPlans() });
    first.stop();

    const second = createActor(runOptionsMachine).start();

    expect(second.getSnapshot().context).toEqual(RUN_OPTIONS_OFF);
    second.stop();
  });
});

describe("toRunSubmissionOptions", () => {
  it("should submit no Query plans settings while the flag is off", () => {
    expect(toRunSubmissionOptions(makeRunOptions({ debug: true }))).toEqual({ debug: true, queryPlans: undefined });
  });

  it("should submit the size and real time measure while the flag is on", () => {
    const options = makeRunOptions({ queryPlans: makeQueryPlans({ size: "1m", measureRealTime: true }) });

    expect(toRunSubmissionOptions(options)).toEqual({
      debug: false,
      queryPlans: { size: "1m", measureRealTime: true },
    });
  });
});
