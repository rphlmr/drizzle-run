import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import type { CloudLeave, CloudSync } from "./cloud-sync";

function countProjects(count: number, kind: "Cloud" | "Local"): string {
  return count === 1 ? `Your ${kind} project` : `Your ${count} ${kind} projects`;
}

function describeSignOut(cloudCount: number, localCount: number): string {
  const cloud =
    cloudCount === 0
      ? ""
      : `${countProjects(cloudCount, "Cloud")} ${cloudCount === 1 ? "leaves" : "leave"} this browser. ${cloudCount === 1 ? "It comes" : "They come"} back when you sign in.`;
  const local =
    localCount === 0 ? "" : `${countProjects(localCount, "Local")} ${localCount === 1 ? "stays" : "stay"} here.`;

  return [cloud, local].filter((part) => part !== "").join(" ");
}

function describeUnsaved(unsavedCount: number, error: string): string {
  const reason = error === "" || /[.!?]$/.test(error) ? error : `${error}.`;
  const unsaved =
    unsavedCount === 0
      ? ""
      : unsavedCount === 1
        ? "A Cloud project has edits that didn't save to your account."
        : `${unsavedCount} Cloud projects have edits that didn't save to your account.`;
  const consequence =
    unsavedCount === 0
      ? "Signing out anyway removes your Cloud projects from this browser, with any edits not saved yet."
      : "Signing out anyway removes them from this browser, and those edits are lost.";

  return [unsaved, reason, consequence].filter((part) => part !== "").join(" ");
}

function SignOutBody({ leave, cloudSync }: { leave: CloudLeave; cloudSync: CloudSync }) {
  if (leave.step === "unsaved") {
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            {leave.unsavedCount === 0 ? "Your account can't be reached" : "Some edits aren't in your account"}
          </DialogTitle>
          <DialogDescription>{describeUnsaved(leave.unsavedCount, leave.error)}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={cloudSync.cancelSignOut}>
            Cancel
          </Button>
          <Button variant="outline" onClick={cloudSync.retrySignOut}>
            Try again
          </Button>
          <Button variant="destructive" onClick={cloudSync.confirmSignOut}>
            Sign out anyway
          </Button>
        </DialogFooter>
      </>
    );
  }

  const busy = leave.step !== "asking";

  return (
    <>
      <DialogHeader>
        <DialogTitle>Sign out?</DialogTitle>
        {leave.step === "asking" && (
          <DialogDescription>{describeSignOut(leave.cloudCount, leave.localCount)}</DialogDescription>
        )}
        {leave.step === "saving" && <DialogDescription>Saving your last edits…</DialogDescription>}
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={cloudSync.cancelSignOut}>
          Cancel
        </Button>
        <Button disabled={busy} onClick={cloudSync.confirmSignOut}>
          Sign out
        </Button>
      </DialogFooter>
    </>
  );
}

/** Confirms a sign-out, says which projects leave this browser, and offers to save again when edits did not save. */
export function SignOutDialog({ cloudSync }: { cloudSync: CloudSync }) {
  const leave = cloudSync.leave;

  return (
    <Dialog
      open={leave !== null && leave.step !== "signing_out"}
      onOpenChange={(open) => {
        if (!open && (leave?.step === "asking" || leave?.step === "unsaved")) {
          cloudSync.cancelSignOut();
        }
      }}
    >
      <DialogContent showCloseButton={false}>
        {leave !== null && <SignOutBody leave={leave} cloudSync={cloudSync} />}
      </DialogContent>
    </Dialog>
  );
}
