import type { RunResult } from "@drizzle-run/core/contracts";
import {
  isPairProject,
  resolveStep,
  type GuideManifest,
  type GuideProject,
  type GuideStep,
  type RunResultDiff,
} from "@drizzle-run/core/guide";
import {
  GuideProvider,
  useGuideLastRun,
  useGuideActions,
  useGuideStep,
  type GuideLastRun,
  type GuideProgress,
} from "@drizzle-run/react";
import {
  isPairRunResult,
  listGuideCheckedRuns,
  type GuideCheckedRun,
  type GuideComparison,
} from "@drizzle-run/runtime/guides";
import { useActorRef, useSelector } from "@xstate/react";
import { isEqual } from "es-toolkit";
import { CircleCheckIcon, LockIcon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ActorRefFrom } from "xstate";

import type { ConnectViewOptions } from "../connect/connect-provider";
import { diffLines, getAddedRanges } from "../lib/line-diff";
import { ProjectView, type AsideControls, type ProjectControl, type ProjectViewProps } from "../project/project-view";
import type { OneVersionProject, ProjectRecord } from "../project/projects";
import { SideBySideView, type SideBySideControl } from "../side-by-side/side-by-side-view";
import { VolatileProjectStorage, type SettingStore } from "../store/storage";
import type { OutputComparison } from "../ui/output-panel";
import { getStepNotes } from "../ui/run-notes";
import { useWorkspace } from "../workspace/context";
import type { SaveState } from "../workspace/save-state";
import { GUIDE_SEEN_SETTING, readStepNoteMeta } from "./catalog";
import { GuideRail, type GuideDone, type GuideLeave } from "./guide-rail";
import { createGuidedStageMachine, getFilesBefore } from "./guided-stage-machine";
import { describeComparedRun } from "./what-changed";

/** The guide's last run, when it was one-version, kept to compare the output with. */
interface GuideRun {
  result: RunResult;
  /** What changed since the run before; absent once the guide moved past the step it ran at. */
  changes: RunResultDiff | undefined;
  /** The 0-based step it ran at. */
  step: number;
  /** The run it was compared with, when there was one. */
  since: GuideComparison | undefined;
}

type Files = Readonly<Record<string, string>>;

export interface GuidedPlaygroundProps extends Pick<
  ProjectViewProps,
  "storage" | "saveState" | "banner" | "projectActions"
> {
  guide: GuideManifest;
  /** The one-version project the guide walks; steps that split show a temporary side-by-side copy instead. */
  project: OneVersionProject;
  update: (project: OneVersionProject) => void;
  /** Where the guide's progress is saved. */
  settings: SettingStore;
  progressKey: string;
  /** The guide's AI chat, opened from the header (see `connect/conversations.ts`). */
  conversation?: string;
  /** The save state while the editor is locked, in place of `saveState`. */
  lockedSaveState?: SaveState;
  /**
   * "Fork to my projects", given the copy on screen: the walked project, or a side-by-side step's pair. Shown once the
   * editor unlocks: while steps run, they change the project.
   */
  renderFork?: (project: ProjectRecord) => ReactNode;
  /** Saves the copy on screen to My projects from the leave dialog. */
  forkBeforeLeaving?: (project: ProjectRecord) => Promise<unknown>;
  /** A 0-based step to open, such as from the address. */
  startAt?: number;
  renderLeading: (view: { index: number; count: number; finished: boolean }) => ReactNode;
  leave: GuideLeave;
  /** The editor bar while the guide runs, given the steps left. */
  lockedMessage: (stepsLeft: number) => string;
  done: GuideDone;
  /** The step changed, or the guide finished (`index` is then the step count). */
  onPosition?(index: number): void;
  /**
   * A run at step `index` settled: one entry, or one per side for a side-by-side step, each with the files it ran.
   * Pass an entry to `evaluateChecks(run.result, checks, { files: run.files })` to check the step.
   */
  onRunSettled?(settled: { index: number; runs: GuideCheckedRun[] }): void;
  /** The learner left the guide, or it opened on a project edited outside it, whose files it keeps. */
  onLeave?: () => void;
  onDone?(): void;
}

/** How the read-only notices name the rail's leave button, so they point at the button the learner sees. */
const leaveVerbs = { pause: "Pause", skip: "Skip" } satisfies Record<GuideLeave, string>;

function hasSameFiles(left: Files, right: Files) {
  return isEqual(left, right);
}

/**
 * The lines the last step added, for "Step 3 added lines 29 to 38 of query.ts.": its focus when it has one, else the
 * largest block it added, so a one-line import does not stand for the step.
 */
function findLastStepLines(guide: GuideManifest): { file: string; startLine: number; endLine: number } | undefined {
  const { step: lastStep, previous, project } = resolveStep(guide, guide.steps.length - 1);

  if (isPairProject(project)) {
    return undefined;
  }

  if (lastStep.focus) {
    return { file: lastStep.focus.file, startLine: lastStep.focus.lines[0], endLine: lastStep.focus.lines[1] };
  }

  const before = getFilesBefore(previous, lastStep);
  const { files } = project;
  const added = Object.keys(files).flatMap((file) =>
    before[file] === files[file]
      ? []
      : getAddedRanges(diffLines(before[file] ?? "", files[file])).map((range) => ({ file, ...range })),
  );

  return added.toSorted((left, right) => right.endLine - right.startLine - (left.endLine - left.startLine))[0];
}

/**
 * A project walked through by a guide manifest: the guide machine owns the steps and the scripted edits, the project
 * view runs the code, and the rail shows the step. A step that splits the project shows both sides in a side-by-side
 * view over a temporary copy; the walked project keeps the one-version files.
 */
export function GuidedPlayground(props: GuidedPlaygroundProps) {
  const { guide, settings, progressKey, startAt } = props;
  const workspace = useWorkspace();
  const control = useRef<ProjectControl>(null);
  const pairControl = useRef<SideBySideControl>(null);
  const writeProject = useEffectEvent((project: OneVersionProject) => props.update(project));
  const leaveGuide = useEffectEvent(() => props.onLeave?.());
  const [stageMachine] = useState(() => createGuidedStageMachine({ writeProject: (project) => writeProject(project) }));
  const stage = useActorRef(stageMachine, { input: { guide, projectName: props.project.name } });

  useEffect(() => {
    const errors = stage.on("stage.error", ({ message }) => workspace.reportError(message));
    const editedOutside = stage.on("stage.edited_outside", () => leaveGuide());

    return () => {
      errors.unsubscribe();
      editedOutside.unsubscribe();
    };
  }, [stage, workspace]);

  const showStep = (index: number, step: GuideStep, stepProject: GuideProject) => {
    props.onPosition?.(index);
    stage.send({ type: "step.show", index, step, project: stepProject, walked: props.project });
  };

  return (
    <GuideProvider
      manifest={guide}
      startAt={startAt}
      services={{
        run: (manifest, signal) => {
          const loading = new Error("The editor is still loading. Try again in a moment.");

          if (isPairProject(manifest)) {
            return pairControl.current ? pairControl.current.run(manifest, signal) : Promise.reject(loading);
          }

          return control.current ? control.current.run(manifest, signal) : Promise.reject(loading);
        },
        loadProgress: () => settings.readSetting(progressKey),
        saveProgress: (progress: GuideProgress) => settings.writeSetting(progressKey, progress),
      }}
      callback={{
        onStepChange: ({ index, step, project: stepProject }) => showStep(index, step, stepProject),
        onRunSettled: ({ index, project: ranProject, result }) => {
          props.onRunSettled?.({ index, runs: listGuideCheckedRuns(result, ranProject) });
        },
        onLeave: props.onLeave,
        onDone: () => {
          void settings.writeSetting(GUIDE_SEEN_SETTING, true).catch(() => undefined);
          props.onPosition?.(guide.steps.length);
          props.onDone?.();
        },
      }}
    >
      <GuidedSession {...props} control={control} pairControl={pairControl} stage={stage} />
    </GuideProvider>
  );
}

interface GuidedSessionProps extends GuidedPlaygroundProps {
  control: RefObject<ProjectControl | null>;
  pairControl: RefObject<SideBySideControl | null>;
  stage: ActorRefFrom<ReturnType<typeof createGuidedStageMachine>>;
}

/**
 * The guide's last run, when it was one-version
 *
 * Its comparison with the run before holds only while the guide is on the step it ran at, and only when an output
 * changed, not when every output is new.
 */
function getLastGuideRun(context: GuideLastRun): GuideRun | undefined {
  const { lastResult, lastResultStep, result, changes, since } = context;

  if (lastResult === undefined || lastResultStep === undefined || isPairRunResult(lastResult)) {
    return undefined;
  }

  const current = result === lastResult ? changes : undefined;

  return {
    result: lastResult,
    changes: current,
    step: lastResultStep,
    since: current?.displays.some((display) => display.status !== "added") ? since : undefined,
  };
}

function GuidedSession({
  guide,
  project,
  update,
  storage,
  saveState,
  lockedSaveState = saveState,
  banner,
  projectActions = false,
  renderLeading,
  leave,
  lockedMessage,
  done,
  control,
  pairControl,
  stage,
  conversation,
  renderFork,
  forkBeforeLeaving,
}: GuidedSessionProps) {
  const workspace = useWorkspace();
  const view = useGuideStep();
  const events = useGuideActions();
  const lastRun = getLastGuideRun(useGuideLastRun());
  const { fileOverride, highlight, pair: pairStage } = useSelector(stage, (snapshot) => snapshot.context);
  const [collapsed, setCollapsed] = useState(false);
  const [railWidthPx, setRailWidthPx] = useState<number | null>(null);
  const [pairStorage] = useState(() => new VolatileProjectStorage());
  const locked = view.editorLocked;
  const leaveVerb = leaveVerbs[leave];
  const finished = view.stage === "done";
  const added =
    finished && hasSameFiles(project.manifest.files, view.project.files) ? findLastStepLines(guide) : undefined;
  const addedLines =
    added &&
    (added.startLine === added.endLine ? `line ${added.startLine}` : `lines ${added.startLine} to ${added.endLine}`);
  const addedText = added && `Step ${guide.steps.length} added ${addedLines} of ${added.file}.`;

  const earlier = lastRun !== undefined && (lastRun.step !== view.index || view.stage === "before");
  const ran = lastRun?.step === view.index && (view.stage === "after" || view.stage === "failed");
  const stepNotes = useMemo(() => {
    const step = guide.steps[view.index];

    if (!locked || step === undefined) {
      return [];
    }

    const { previous, project: stepProject } = resolveStep(guide, view.index);

    if (isPairProject(stepProject)) {
      return [];
    }

    return getStepNotes({
      before: getFilesBefore(previous, step),
      after: stepProject.files,
      index: view.index,
      ran,
      meta: readStepNoteMeta(guide, step),
    });
  }, [guide, locked, ran, view.index]);
  const since = lastRun?.since && describeComparedRun(guide, lastRun.since, lastRun.step);
  const comparison: OutputComparison | undefined = lastRun && {
    result: lastRun.result,
    changes: earlier || since === undefined ? undefined : lastRun.changes,
    runLabel: `Step ${lastRun.step + 1} run`,
    earlier,
    compareLabel: since === "the last run" ? "vs last run" : since && `vs ${since}`,
  };

  const editorBar = locked ? (
    <p
      className="m-0 flex h-9.5 shrink-0 items-center gap-2 overflow-hidden border-b border-border bg-panel px-3.5 text-[12.5px] whitespace-nowrap text-muted [&>svg]:size-3.5 [&>svg]:shrink-0"
      data-slot="editor-bar"
    >
      <LockIcon aria-hidden="true" />
      <span className="max-phone:hidden">{lockedMessage(view.count - view.index)}</span>
      <span className="hidden max-phone:inline">Read-only during the guide</span>
    </p>
  ) : finished ? (
    <p
      className="m-0 flex h-9.5 shrink-0 items-center gap-2 overflow-hidden border-b border-border bg-ok-bg px-3.5 text-[12.5px] whitespace-nowrap [&>svg]:size-3.5 [&>svg]:shrink-0"
      data-slot="editor-bar"
    >
      <CircleCheckIcon aria-hidden="true" className="text-ok" />
      <span className="font-semibold text-ok max-phone:hidden">Guide complete. The editor is unlocked.</span>
      <span className="hidden font-semibold text-ok max-phone:inline">Editor unlocked</span>
      {addedText && (
        <span className="min-w-0 truncate text-muted max-phone:hidden" title={addedText}>
          {addedText}
        </span>
      )}
    </p>
  ) : undefined;

  const connect: ConnectViewOptions = {
    scope: "guide",
    guide: () => ({ manifest: guide, index: view.index, stage: view.stage }),
    conversation,
    position: `${finished ? "Guide complete" : `Step ${view.index + 1} of ${view.count}`} · ${project.name}`,
  };
  const aside = {
    label: "Guide",
    sheet: true,
    collapsed,
    railWidth: { px: railWidthPx, onChange: setRailWidthPx },
    renderContent: (controls: AsideControls) => (
      <GuideRail
        guide={guide}
        controls={controls}
        leave={leave}
        done={done}
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
      />
    ),
  };
  const leading = renderLeading({ index: view.index, count: view.count, finished });
  const highlightedDisplays = locked && view.stage === "after" && !earlier ? view.step.highlight?.displays : undefined;
  const runDisabled = !locked
    ? undefined
    : view.stage === "loading"
      ? "The guide is opening. Run it in a moment."
      : view.step.run === "none"
        ? "This step has nothing to run. Read it, then go to the next step."
        : undefined;

  // Only one view is mounted at a time: the editors share Monaco's TypeScript options and the page runtime.
  if (pairStage) {
    return (
      <SideBySideView
        project={pairStage.project}
        storage={pairStorage}
        update={(next) => stage.send({ type: "pair.edit", project: next })}
        saveState={locked ? lockedSaveState : "side_by_side_step"}
        unsavedCopy={!locked && !isEqual(pairStage.project.manifest, pairStage.shown)}
        reportError={workspace.reportError}
        projectActions={false}
        leading={leading}
        fork={locked ? undefined : renderFork?.(pairStage.project)}
        forkBeforeLeaving={forkBeforeLeaving && (() => forkBeforeLeaving(pairStage.project))}
        banner={banner}
        readOnly={
          locked ? `Both editors are read-only while the guide runs. ${leaveVerb} the guide to edit.` : undefined
        }
        sidesLocked={locked ? "Set by the guide" : undefined}
        fileOverride={pairStage.fileOverride}
        highlight={pairStage.marks}
        onRunRequest={locked ? events.run : undefined}
        runDisabled={runDisabled}
        highlightedDisplays={highlightedDisplays}
        control={pairControl}
        runNotes="guided"
        connect={connect}
        aside={aside}
      />
    );
  }

  return (
    <ProjectView
      project={project}
      storage={storage}
      update={update}
      saveState={locked ? lockedSaveState : saveState}
      unsavedCopy={saveState === "temporary" && !locked && !hasSameFiles(project.manifest.files, view.project.files)}
      reportError={workspace.reportError}
      projectActions={projectActions}
      leading={leading}
      fork={locked ? undefined : renderFork?.(project)}
      forkBeforeLeaving={forkBeforeLeaving && (() => forkBeforeLeaving(project))}
      banner={banner}
      fileOverride={fileOverride}
      highlight={highlight}
      releaseLocked={
        locked ? `The release is fixed while the guide runs. ${leaveVerb} the guide to change it.` : undefined
      }
      runTarget={locked && view.stage === "before" && view.canRun ? `step ${view.index + 1}` : undefined}
      readOnly={locked ? `Read-only while the guide runs. ${leaveVerb} the guide to edit.` : undefined}
      onRunRequest={locked ? events.run : undefined}
      runDisabled={runDisabled}
      control={control}
      editorBar={editorBar}
      comparison={comparison}
      highlightedDisplays={highlightedDisplays}
      runNotes={earlier ? "off" : "guided"}
      stepNotes={stepNotes}
      phoneHeaderRun={!locked}
      connect={connect}
      aside={aside}
    />
  );
}
