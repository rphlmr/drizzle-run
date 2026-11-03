import { PlayIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { Hint } from "../ui/hint";
import { DisabledReasonTrigger, RunButtonIcon, RunShortcut } from "../ui/run-button";

export interface RunBothButtonProps {
  running: boolean;
  bothReady: boolean;
  /** A side's runtime failed or this browser cannot run it. */
  unavailable: boolean;
  canRun: boolean;
  /** Why Run both is disabled, shown in its hint while no side prepares, such as a guide step without a run. */
  disabledReason?: string;
  /** Phones have no keyboard shortcut to show. */
  phone: boolean;
  onRun: () => void;
  onCancel: () => void;
}

/** Spins in place of the play icon, sized like it so the button keeps its width. */
function Spinner() {
  return (
    <span
      className="size-3 shrink-0 rounded-full border-2 border-on-lime/25 border-t-on-lime motion-safe:animate-spin"
      aria-hidden="true"
    />
  );
}

/** Run both: spins while a side prepares and cancels the pair while it runs. */
export function RunBothButton({
  running,
  bothReady,
  unavailable,
  canRun,
  disabledReason,
  phone,
  onRun,
  onCancel,
}: RunBothButtonProps) {
  const preparing = !bothReady && !unavailable;
  const shownReason = !running && !preparing && !canRun ? disabledReason : undefined;
  const button = (
    <Button
      variant="run"
      size="run"
      data-guide="run"
      data-state={running ? "running" : preparing ? "preparing" : "ready"}
      className="min-w-37.5 justify-center"
      disabled={!running && !canRun}
      aria-busy={(!running && preparing) || undefined}
      onClick={running ? onCancel : onRun}
    >
      {running ? <RunButtonIcon state="running" /> : preparing ? <Spinner /> : <PlayIcon aria-hidden="true" />}
      {running ? "Cancel" : "Run both"}
      {!running && !phone && <RunShortcut />}
    </Button>
  );

  return (
    <Hint
      key={shownReason === undefined ? "button" : "reason"}
      content={running ? "Stops both sides" : (shownReason ?? "Runs both sides, each in a fresh runtime")}
    >
      {shownReason === undefined ? button : <DisabledReasonTrigger>{button}</DisabledReasonTrigger>}
    </Hint>
  );
}
