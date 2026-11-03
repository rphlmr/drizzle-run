import { useActorRef, useSelector } from "@xstate/react";
import { useCallback } from "react";

import {
  getPhoneView,
  getWorkView,
  workspaceViewMachine,
  type WorkspaceViewEvent,
  type WorkspaceViewInput,
} from "./workspace-view-machine";

/**
 * What a phone shows of a project view
 *
 * Reads the view machine for render and sends it the reader's choices. The input is read once, when the view mounts.
 */
export function useWorkspaceView(input: WorkspaceViewInput) {
  const actor = useActorRef(workspaceViewMachine, { input });
  const phoneView = useSelector(actor, getPhoneView);
  const workView = useSelector(actor, getWorkView);
  const side = useSelector(actor, (snapshot) => snapshot.context.side);
  const unseenOutput = useSelector(actor, (snapshot) => snapshot.context.unseenOutput);
  const send = useCallback((event: WorkspaceViewEvent) => actor.send(event), [actor]);

  return {
    /** The side panel, the code or the output. */
    phoneView,
    /** The work area's code or output, kept while the side panel shows. */
    workView,
    asideShown: phoneView === "aside",
    side,
    unseenOutput,
    send,
  };
}

/** A project view's phone views and their sender. */
export type WorkspaceView = ReturnType<typeof useWorkspaceView>;
