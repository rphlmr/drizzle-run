import { useRef, useState } from "react";
import type { Blocker } from "react-router";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { getErrorText } from "../lib/error-text";

type ForkState = { status: "idle" } | { status: "forking" } | { status: "failed"; error: string };

/** Props of the dialog: the held navigation, and how to keep the copy before it goes on. */
export interface LeaveDialogProps {
  blocker: Blocker;
  /** Saves the copy to My projects. When set, the dialog offers Fork and leave. */
  onFork?: () => Promise<unknown>;
}

/**
 * Asks before a held navigation drops the edits to a copy
 *
 * Shows while `blocker` is blocked. Stay, the default, keeps the page and its edits; Leave without saving lets the
 * navigation go on; Fork and leave saves the copy first, and keeps the dialog open with the reason when that fails.
 */
export function LeaveDialog({ blocker, onFork }: LeaveDialogProps) {
  const stayRef = useRef<HTMLButtonElement>(null);
  const [fork, setFork] = useState<ForkState>({ status: "idle" });
  const forking = fork.status === "forking";

  const stay = () => {
    setFork({ status: "idle" });
    blocker.reset?.();
  };
  const forkAndLeave = async (save: () => Promise<unknown>) => {
    setFork({ status: "forking" });

    try {
      await save();
    } catch (cause) {
      setFork({ status: "failed", error: getErrorText(cause) });

      return;
    }

    setFork({ status: "idle" });
    blocker.proceed?.();
  };

  return (
    <Dialog
      open={blocker.state === "blocked"}
      onOpenChange={(open) => {
        if (!open && !forking) {
          stay();
        }
      }}
    >
      <DialogContent initialFocus={stayRef} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Leave without saving?</DialogTitle>
          <DialogDescription>
            {onFork
              ? "Your edits to this copy are not saved anywhere. Fork it to keep them in My projects."
              : "Your edits to this copy are not saved anywhere. To keep them, stay and press Fork to my projects."}
          </DialogDescription>
        </DialogHeader>
        {fork.status === "failed" && (
          <p role="alert" className="text-[13px] text-err">
            {fork.error}
          </p>
        )}
        <DialogFooter>
          <Button variant="destructive" disabled={forking} onClick={() => blocker.proceed?.()}>
            Leave without saving
          </Button>
          <Button ref={stayRef} variant="outline" disabled={forking} onClick={stay}>
            Stay
          </Button>
          {onFork && (
            <Button disabled={forking} onClick={() => void forkAndLeave(onFork)}>
              {forking ? "Forking…" : "Fork and leave"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
