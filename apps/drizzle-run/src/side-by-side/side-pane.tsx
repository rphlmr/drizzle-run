import type { Diagnostic, QueryPlansSettings } from "@drizzle-run/core/contracts";
import { isSharedPairFile, pairSide, type PairManifest } from "@drizzle-run/core/pair";
import { type RunSubmission } from "@drizzle-run/orchestration";
import { preparationPercent } from "@drizzle-run/runtime/machines";
import { ChevronDownIcon, Link2Icon, LockIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { CodePreview } from "../ui/code-preview";
import type { FirstRunStatus } from "../ui/first-run-card";
import { Hint } from "../ui/hint";
import { LibrariesPopover } from "../ui/libraries-popover";
import { OutputPanel } from "../ui/output-panel";
import type { OutputSettingsProps } from "../ui/output-settings";
import { getReleaseCurrent } from "../ui/release-options";
import { useEditorFontSize } from "../ui/use-editor-font-size";
import { useTabAfterRun } from "../ui/use-tab-after-run";
import { CodeOutputSplit } from "../workspace/code-output-split";
import type { LinkedSplit } from "../workspace/linked-splits";
import { useRunMarks, type RunNotesMode } from "../workspace/run-marks";
import { SIDE_OUTPUT_DEFAULT_PX, SIDE_SPLIT_PANE_MIN_PX } from "../workspace/workspace-layout";
import type { WorkView } from "../workspace/workspace-view-machine";
import { ChangeSidePopover } from "./change-side-popover";
import type { SideRelease } from "./side-labels";
import { SideName } from "./side-name";
import { getShownSideTab, useSideStatus, type SideTab } from "./side-output";
import type { SidePlayground } from "./use-side";

/** The pill's label before a first run while the side's runtime is not ready, undefined once it is. */
export function getPreparingLabel(side: SidePlayground): string | undefined {
  if (side.editorReady) {
    return undefined;
  }

  return side.ready.matches("failed") || side.ready.matches("unsupported") ? "Runtime unavailable" : "Preparing";
}

/** A side's database, release line and ORM and Kit versions, as its pane head's release chip writes them. */
export function SideReleaseText({ release }: { release: SideRelease }) {
  return (
    <>
      <span className="shrink-0 text-muted">{release.database}</span>
      <span className="shrink-0 font-semibold">{release.line}</span>
      <span className="min-w-0 truncate font-mono text-[11px] text-muted @max-[36rem]:hidden">{release.pair}</span>
    </>
  );
}

/** True when both file sets hold the same paths with the same contents. */
function haveSameFiles(first: Readonly<Record<string, string>>, second: Readonly<Record<string, string>>): boolean {
  const paths = Object.keys(first);

  return paths.length === Object.keys(second).length && paths.every((path) => first[path] === second[path]);
}

/**
 * The revision the output compares the shown run with. The output calls a run stale when its revision is behind,
 * but an edit on the other side bumps the project's revision too, so a side compares its own files instead.
 */
function getSideRevision(submission: RunSubmission | undefined, sideFiles: Readonly<Record<string, string>>): number {
  if (submission === undefined) {
    return 0;
  }

  return haveSameFiles(submission.manifest.files, sideFiles) ? submission.revision : submission.revision + 1;
}

/** A side's loader state before its first run: preparing with its percent, ready, or unavailable. */
export function getSideFirstRunStatus(side: SidePlayground): FirstRunStatus {
  if (side.editorReady) {
    return { state: "ready" };
  }

  if (side.ready.matches("failed") || side.ready.matches("unsupported")) {
    return { state: "unavailable" };
  }

  return {
    state: "preparing",
    percent: side.ready.matches("preparing") ? preparationPercent(side.ready.context.progress) : null,
  };
}

export interface SidePaneProps {
  side: SidePlayground;
  release: SideRelease;
  manifest: PairManifest;
  selected: string;
  phone: boolean;
  hidden: boolean;
  phoneView: WorkView;
  tab: SideTab;
  onTabChange: (tab: SideTab) => void;
  /** The pill's label before a first run while the side's runtime is not ready. */
  preparing: string | undefined;
  readOnly: boolean;
  sidesLocked: string | undefined;
  canChange: boolean;
  changing: boolean;
  onChanging: (open: boolean) => void;
  onChangeSide: Parameters<typeof ChangeSidePopover>[0]["onConfirm"];
  /** Names the side, or clears its name; left out where the sides cannot change. */
  onRename?: (name: string) => void;
  /** The phone's file pills, above the code. */
  fileTabs: ReactNode;
  /** The Query plans flag as the next run will submit it. */
  queryPlans: QueryPlansSettings | undefined;
  /** The output gear's settings, shared by both sides. */
  settings: OutputSettingsProps;
  /** Off beside a guide's rail, whose steps name each run. */
  runPicker: boolean;
  runNotes: RunNotesMode;
  /** The display labels a guide step points at, scrolled to in this side's results. */
  highlightedDisplays?: readonly string[];
  onDiagnostic: (diagnostic: Diagnostic) => void;
  /** The side's code and output split, linked to the other side's. */
  split: LinkedSplit;
}

/**
 * One side: its pane head (name, pair, shared file, read only), its editor and its output, whose bar holds the run status. It reads the side's
 * run from the closest `RunProvider`. The editor's host keeps its place in the tree on every layout, so Monaco
 * stays bound to it.
 */
export function SidePane({
  side,
  release,
  manifest,
  selected,
  phone,
  hidden,
  phoneView,
  tab,
  onTabChange,
  preparing,
  readOnly,
  sidesLocked,
  canChange,
  changing,
  onChanging,
  onChangeSide,
  onRename,
  fileTabs,
  queryPlans,
  settings,
  runPicker,
  runNotes,
  highlightedDisplays,
  onDiagnostic,
  split,
}: SidePaneProps) {
  const { run } = useSideStatus(preparing);
  const { attachHost, editorReady } = side;

  useRunMarks({
    session: side.session,
    result: run.result,
    mode: runNotes,
  });
  useTabAfterRun({ tab, onTabChange });

  const sideFiles = pairSide(manifest, side.side).files;
  const sideManifest = pairSide(manifest, side.side);
  const preferredFontSize = useEditorFontSize();
  const firstRun = { status: getSideFirstRunStatus(side), dialect: sideManifest.target.dialect, compact: true };
  const pairHint = sidesLocked ?? "Change this side’s Drizzle version";
  const pairButton = (
    <TooltipTrigger
      render={
        <button
          type="button"
          className={cn(
            "relative inline-flex h-6 min-w-0 shrink-100 items-center gap-1.5 rounded-[6px] border border-border bg-surface-2 py-0 pr-1.75 pl-2 text-[12px] whitespace-nowrap text-text after:absolute after:inset-x-0 after:-inset-y-2.5 aria-disabled:cursor-default @max-[36rem]:min-w-auto",
            changing && "shadow-[0_0_0_2px_var(--lime)]",
          )}
          // Not `disabled`: a disabled button gets no hover, and its hint says why it is locked.
          aria-disabled={sidesLocked !== undefined || !canChange || undefined}
          aria-label={`${release.line}, ${release.pair}, ${release.database}. ${pairHint}`}
        />
      }
    >
      <SideReleaseText release={release} />
      {sidesLocked !== undefined ? (
        <LockIcon className="size-2.75 shrink-0 stroke-[2.2]" aria-hidden="true" />
      ) : (
        <ChevronDownIcon className="size-3 shrink-0" aria-hidden="true" />
      )}
    </TooltipTrigger>
  );

  const code = (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-code max-phone:gap-2.5 max-phone:rounded-none max-phone:border-0 max-phone:bg-bg max-phone:px-4 max-phone:pt-2.5">
      {!phone && (
        <div className="@container flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface pr-2.5 pl-3">
          <SideName release={release} onRename={onRename} />
          <Tooltip>
            {sidesLocked === undefined && canChange ? (
              <ChangeSidePopover
                manifest={manifest}
                side={side.side}
                open={changing}
                onOpenChange={onChanging}
                onConfirm={onChangeSide}
                trigger={pairButton}
              />
            ) : (
              pairButton
            )}
            <TooltipContent>{pairHint}</TooltipContent>
          </Tooltip>
          <LibrariesPopover target={sideManifest.target} current={getReleaseCurrent(sideManifest)} size="pane" />
          <span className="flex-1" />
          {isSharedPairFile(manifest, selected) && (
            <Hint content="One file for both sides: an edit on either side shows on both">
              <span className="inline-flex h-5 items-center gap-1.25 rounded-pill bg-mark px-2 text-[11px] font-semibold whitespace-nowrap text-accent-text">
                <Link2Icon className="size-2.75 stroke-[2.2]" aria-hidden="true" />
                <span className="@max-[30rem]:sr-only">Shared file</span>
              </span>
            </Hint>
          )}
          {readOnly && (
            <span className="inline-flex h-5 items-center gap-1.25 rounded-pill bg-surface-2 px-2 text-[11px] font-semibold whitespace-nowrap text-muted">
              <LockIcon className="size-2.75 stroke-[2.2]" aria-hidden="true" />
              <span className="@max-[30rem]:sr-only">Read only</span>
            </span>
          )}
        </div>
      )}
      {phone && <div className="-mx-4 shrink-0 scrollbar-none overflow-x-auto px-4 pt-1.25">{fileTabs}</div>}
      <div className="relative min-h-0 flex-1 max-phone:overflow-hidden max-phone:rounded-[12px] max-phone:border max-phone:border-border max-phone:bg-code">
        <div
          ref={attachHost}
          className="size-full min-h-0 pt-1.5"
          style={{ visibility: editorReady ? "visible" : "hidden" }}
        />
        {!editorReady && (
          <div className="absolute inset-0 flex flex-col bg-code text-[13px] text-muted">
            <CodePreview code={sideFiles[selected] ?? ""} fontSize={preferredFontSize} />
          </div>
        )}
      </div>
    </div>
  );

  const output = (!phone || phoneView === "output") && (
    <div className={cn("h-full min-h-0", phone && "flex flex-col px-4 py-3")}>
      <OutputPanel
        label={release.label}
        revision={getSideRevision(run.submission, sideFiles)}
        bar={!phone}
        tab={phone ? getShownSideTab(tab, run) : tab}
        onTabChange={onTabChange}
        firstRun={firstRun}
        queryPlans={queryPlans}
        settings={settings}
        runPicker={runPicker}
        highlightedDisplays={highlightedDisplays}
        onDiagnostic={onDiagnostic}
      />
    </div>
  );

  return (
    <section
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label={`${release.label}, Drizzle ${release.pair}${release.guestFlavor === "effect" ? ", with Effect 4" : ""}`}
      hidden={hidden}
    >
      <CodeOutputSplit
        orientation="vertical"
        groupRef={split.groupRef}
        onLayoutChange={split.onLayoutChange}
        phone={phone}
        phoneView={phoneView}
        motion={false}
        code={{ content: code, id: split.codeId, minSize: SIDE_SPLIT_PANE_MIN_PX }}
        output={{
          content: output,
          id: split.outputId,
          defaultSize: SIDE_OUTPUT_DEFAULT_PX,
          minSize: SIDE_SPLIT_PANE_MIN_PX,
        }}
        handle={{ label: "Resize code and output", className: "aria-[orientation=horizontal]:h-3" }}
      />
    </section>
  );
}
