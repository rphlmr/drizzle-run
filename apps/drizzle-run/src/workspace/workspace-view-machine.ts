import type { PairSideIndex } from "@drizzle-run/core/pair";
import { assign, setup, type SnapshotFrom } from "xstate";

import { declareType } from "../lib/declare-type";
import type { PhoneView } from "../ui/phone-view-switch";

/** The input of `workspaceViewMachine`, read once when the view mounts. */
export interface WorkspaceViewInput {
  /** The view has a side panel a phone shows as a view of its own, such as a guide's rail; it opens first. */
  asideView: boolean;
  /**
   * Where a phone goes when a run settles: back to the side panel, which shows the run's verdict while the output
   * waits marked as new, or to the output, behind the side panel if it is open.
   */
  afterRun: "aside" | "output";
}

interface WorkspaceViewContext extends WorkspaceViewInput {
  /** The side a phone shows, in a side-by-side project. */
  side: PairSideIndex;
  /** A run settled since the reader last looked at the output. */
  unseenOutput: boolean;
}

/** Changes what a phone shows, or reports a settled run that was not cancelled. */
export type WorkspaceViewEvent =
  | { type: "aside.show" }
  | { type: "work.show" }
  | { type: "code.show"; side?: PairSideIndex }
  | { type: "output.show"; side?: PairSideIndex }
  | { type: "side.show"; side: PairSideIndex }
  | { type: "run.settled"; phone: boolean };

/**
 * Workspace view machine
 *
 * What a phone shows of a project view, in two regions: `pane` is the side panel or the work area, and `work` is the
 * code or the output inside the work area, which a side-by-side project shows for one side at a time. The work view
 * survives the side panel, so leaving the panel returns to the code or output the reader left. Desktops show every
 * pane, so only a settled run's unseen mark matters there.
 */
export const workspaceViewMachine = setup({
  types: {
    context: declareType<WorkspaceViewContext>(),
    input: declareType<WorkspaceViewInput>(),
    events: declareType<WorkspaceViewEvent>(),
  },
  guards: {
    hasAsideView: ({ context }) => context.asideView,
    showsVerdictInAside: ({ context, event }) =>
      event.type === "run.settled" && event.phone && context.asideView && context.afterRun === "aside",
    isPhone: ({ event }) => event.type === "run.settled" && event.phone,
  },
  actions: {
    assignSide: assign({
      side: ({ context, event }) =>
        (event.type === "code.show" || event.type === "output.show" || event.type === "side.show") &&
        event.side !== undefined
          ? event.side
          : context.side,
    }),
  },
}).createMachine({
  id: "workspaceView",
  type: "parallel",
  context: ({ input }) => ({ ...input, side: 0, unseenOutput: false }),
  on: {
    "code.show": { target: [".pane.work", ".work.code"], actions: "assignSide" },
    "output.show": { target: [".pane.work", ".work.output"], actions: ["assignSide", assign({ unseenOutput: false })] },
    "side.show": { actions: "assignSide" },
    "run.settled": [
      { guard: "showsVerdictInAside", target: ".pane.aside", actions: assign({ unseenOutput: true }) },
      { guard: "isPhone", target: ".work.output", actions: assign({ unseenOutput: false }) },
      { actions: assign({ unseenOutput: true }) },
    ],
  },
  states: {
    pane: {
      initial: "opening",
      states: {
        opening: { always: [{ guard: "hasAsideView", target: "aside" }, { target: "work" }] },
        aside: { on: { "work.show": "work" } },
        work: { on: { "aside.show": { guard: "hasAsideView", target: "aside" } } },
      },
    },
    work: {
      initial: "code",
      states: {
        code: {},
        output: {},
      },
    },
  },
});

type WorkspaceViewSnapshot = SnapshotFrom<typeof workspaceViewMachine>;

/** What a phone shows of the work area: the code or the output. */
export type WorkView = Exclude<PhoneView, "aside">;

/** The pane a phone shows: the side panel, or the work area's code or output. */
export function getPhoneView(snapshot: WorkspaceViewSnapshot): PhoneView {
  if (snapshot.matches({ pane: "aside" })) {
    return "aside";
  }

  return getWorkView(snapshot);
}

/** The work area's view, kept while the side panel shows. */
export function getWorkView(snapshot: WorkspaceViewSnapshot): WorkView {
  return snapshot.matches({ work: "output" }) ? "output" : "code";
}
