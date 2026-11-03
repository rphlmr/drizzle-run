import { useActorRef, useSelector } from "@xstate/react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";

import { useAppServices } from "../app-services";
import { useAuth } from "../auth/auth-provider";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { createCloudSession } from "./session-service";
import { countStoredCloudProjects, createStandaloneSignOutMachine } from "./standalone-sign-out-machine";

/** A sign-out where no workspace is open: it asks first when Cloud projects leave this browser. */
export interface StandaloneSignOut {
  start: () => void;
  dialog: ReactNode;
}

/**
 * Sign out from a page without the workspace, such as a shared link
 *
 * Every Cloud project leaves this browser first, as it does from the workspace. The dialog names no project: they are
 * not loaded here. Edits the account lacks can only be saved from the workspace, so the dialog points to My projects.
 */
export function useStandaloneSignOut(): StandaloneSignOut {
  const { cloudProjects, auth: authService } = useAppServices();
  const auth = useAuth();
  const [machine] = useState(() => {
    const session = createCloudSession({
      locks: navigator.locks,
      store: cloudProjects,
      flushProjects: async () => {},
      signOut: async (signal) => {
        await authService.signOut({ signal });
        auth.reportSessionEnded();
      },
    });

    return createStandaloneSignOutMachine({
      countCloudProjects: (githubId) => countStoredCloudProjects(cloudProjects, githubId),
      leaveAccount: (input, signal) => session.signOut(input, signal),
    });
  });
  const actor = useActorRef(machine);
  const state = useSelector(actor, (snapshot) => snapshot);
  const retrying = state.matches("checking") && state.context.error !== "";
  const asking = state.matches("asking") || state.matches("removing");
  const failed = state.matches("failed") || retrying;
  const busy = state.matches("removing") || retrying;
  const unsavedCount = state.context.unsavedCount;
  const cancel = () => actor.send({ type: "sign_out.cancel" });

  return {
    start: () => {
      if (auth.user !== null) {
        actor.send({ type: "sign_out.start", githubId: auth.user.githubId });
      }
    },
    dialog: (
      <Dialog
        open={asking || failed}
        onOpenChange={(open) => {
          if (!open && !busy) {
            cancel();
          }
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Sign out?</DialogTitle>
            <DialogDescription>
              {failed
                ? `Your Cloud projects could not leave this browser: ${state.context.error} You stay signed in.`
                : describeLeaving(unsavedCount)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={cancel}>
              Cancel
            </Button>
            {asking && unsavedCount > 0 && (
              <Button
                variant="outline"
                nativeButton={false}
                render={<Link to="/projects" className="no-underline" />}
                onClick={cancel}
              >
                Open My projects
              </Button>
            )}
            {failed ? (
              <Button disabled={busy} onClick={() => actor.send({ type: "sign_out.retry" })}>
                Try again
              </Button>
            ) : (
              <Button
                variant={unsavedCount > 0 ? "destructive" : "default"}
                disabled={busy}
                onClick={() => actor.send({ type: "sign_out.confirm" })}
              >
                {unsavedCount > 0 ? "Sign out anyway" : "Sign out"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ),
  };
}

function describeLeaving(unsavedCount: number): string {
  const leaving = "Your Cloud projects leave this browser. They come back when you sign in.";

  if (unsavedCount === 0) {
    return leaving;
  }

  const unsaved =
    unsavedCount === 1
      ? "One has edits that aren't in your account yet."
      : `${unsavedCount} have edits that aren't in your account yet.`;

  return `${leaving} ${unsaved} Open My projects to save them, or sign out anyway and lose those edits.`;
}
