import { CommandIcon, CornerDownLeftIcon, PlayIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { Hint } from "./hint";
import { getRunTooltip } from "./run-shortcut";

/** What the Run button can do: run, wait for the runtime, or cancel the run in progress. */
export type RunButtonState = "ready" | "preparing" | "running";

/** Whether the shortcut uses Command rather than Ctrl; false outside a browser. */
export function isApplePlatform() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** The run shortcut in words, for tooltips and accessible names. */
export function getRunShortcutLabel() {
  return isApplePlatform() ? "⌘ Return" : "Ctrl Enter";
}

// Drawn with icons: the mono font's Latin subset has no ⌘ or ↵ glyph.
/**
 * The shortcut chip inside every Run button, hidden on phones
 *
 * It takes the button's text color on a translucent ink fill, so it reads on lime in both themes. A compact button
 * passes a smaller size through `className`.
 */
export function RunShortcut({ className }: { className?: string }) {
  return (
    <kbd
      className={cn(
        "-mr-1.5 inline-flex h-5.5 items-center gap-0.5 rounded-[5px] bg-kbd px-1.25 font-sans text-[12px] leading-none font-semibold max-phone:hidden [&_svg]:size-3.25 [&_svg]:fill-none [&_svg]:stroke-[2.25]",
        className,
      )}
      aria-hidden="true"
    >
      {isApplePlatform() ? <CommandIcon /> : "Ctrl"}
      <CornerDownLeftIcon />
    </kbd>
  );
}

export interface RunButtonProps {
  state: RunButtonState;
  /** The project's run and seed files, named in the tooltip. */
  entrypoints: { run?: string; seed?: string };
  /** Ready but unable to run (failed preparation, no run entrypoint). */
  disabled?: boolean;
  /** Why Run is disabled, shown in its tooltip in place of the shortcut, such as a guide step without a run. */
  disabledReason?: string;
  /** What Run runs, after the word, such as "step 2" in a guide for "Run step 2". Phones show "Run" alone. */
  target?: string;
  /** Shows the keyboard shortcut beside the label; the embed leaves it out. */
  shortcut?: boolean;
  onRun: () => void;
  onCancel: () => void;
}

/** Spins in place of the play icon while the runtime prepares; sized like the icon so the button keeps its width. */
function Spinner() {
  return (
    <span
      className="size-3.5 shrink-0 rounded-full border-2 border-on-lime/25 border-t-on-lime motion-safe:animate-spin"
      aria-hidden="true"
    />
  );
}

/** A ring spinning around the stop square while a run goes, so Cancel reads as busy rather than idle. */
function RunningStop() {
  return (
    <span className="relative grid size-4 shrink-0 place-items-center" aria-hidden="true">
      <span className="absolute inset-0 rounded-full border-2 border-current/20 border-t-current motion-safe:animate-spin" />
      <span className="size-1.5 rounded-[1px] bg-current" />
    </span>
  );
}

/** The icon of a Run button in each state: play when ready, a spinner while preparing, a spinning stop while running. */
export function RunButtonIcon({ state }: { state: RunButtonState }) {
  switch (state) {
    case "ready":
      return <PlayIcon aria-hidden="true" />;
    case "preparing":
      return <Spinner />;
    case "running":
      return <RunningStop />;
  }
}

/**
 * Takes hover for a disabled button, which takes no pointer events itself, so its hint can say why it is disabled
 */
export function DisabledReasonTrigger({ children, ...props }: ComponentProps<"span">) {
  return (
    <span {...props} className="inline-flex rounded-base">
      {children}
    </span>
  );
}

/** The Run button: Run while ready, Cancel while a run is going, a spinner while the runtime prepares. */
export function RunButton({
  state,
  entrypoints,
  disabled = false,
  disabledReason,
  target,
  shortcut: showShortcut = true,
  onRun,
  onCancel,
}: RunButtonProps) {
  const running = state === "running";
  const preparing = state === "preparing";
  const shortcut = getRunShortcutLabel();
  const shownReason = !running && !preparing && disabled ? disabledReason : undefined;
  const tooltip = running
    ? "Stop this run"
    : preparing
      ? "Run is available once the runtime is ready"
      : (shownReason ?? getRunTooltip(entrypoints, shortcut));
  const button = (
    <Button
      variant="run"
      size="run"
      data-guide="run"
      data-state={state}
      disabled={!running && (preparing || disabled)}
      aria-busy={preparing || undefined}
      onClick={running ? onCancel : onRun}
    >
      <RunButtonIcon state={state} />
      {running ? (
        "Cancel"
      ) : target === undefined ? (
        "Run"
      ) : (
        <span>
          Run<span className="max-phone:sr-only"> {target}</span>
        </span>
      )}
      {!running && showShortcut && <RunShortcut />}
    </Button>
  );

  return (
    <Hint key={shownReason === undefined ? "button" : "reason"} content={tooltip}>
      {shownReason === undefined ? button : <DisabledReasonTrigger>{button}</DisabledReasonTrigger>}
    </Hint>
  );
}
