import type { Executor, RecordedRunResult } from "@drizzle-run/core/contracts";
import type { RunManifestTarget } from "@drizzle-run/core/manifest";
import { PAIR_SIDES, pairSide, type PairSideIndex } from "@drizzle-run/core/pair";
import { type RunOutcome } from "@drizzle-run/orchestration";
import { useRuntimeComparisonController, useControllerSelector } from "@drizzle-run/react";
import { RunProvider } from "@drizzle-run/react";
import type { BrowserRuntime } from "@drizzle-run/runtime/browser";
import { LockIcon, PlayIcon } from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useState, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { Segmented, SegmentedItem, SegmentedList, SegmentedPanel } from "../components/ui/segmented";
import { RecordedNote, RunInNewTabLink, type RecordedBy, type RecordedReason } from "../embed/recorded-embed";
import { getRuntimePolicy } from "../lib/runtime-policy";
import { cn } from "../lib/utils";
import { formatProjectDialects, type SideBySideProject } from "../project/projects";
import { CodePreview } from "../ui/code-preview";
import { FileTabs } from "../ui/file-tabs";
import { Hint } from "../ui/hint";
import { LogoTile } from "../ui/logo-tile";
import { PreparationFailedDialog } from "../ui/preparing-card";
import { RunButtonIcon } from "../ui/run-button";
import { useMediaQuery } from "../ui/use-media-query";
import { EMBED_SIDE_VIEWS, EMBED_TWO_COLUMNS_QUERY, getEmbedViewAfterRun, type EmbedSideView } from "./embed-layout";
import { getSideReleases, listPairFiles, type SideRelease } from "./side-labels";
import { SideOutputBody, SidePillChip, useSideStatus, type SidePill } from "./side-output";
import { getSideFirstRunStatus, SideReleaseText } from "./side-pane";
import { useSide, type SidePlayground } from "./use-side";

/** Props of the side-by-side embed. */
export interface SideBySideEmbedProps {
  project: SideBySideProject;
  /** The full playground, opened in a new tab: the side-by-side share. */
  playgroundHref: string;
  /** The page-owned runtime coordinates comparisons through SDK child runtimes and supports first-side readiness. */
  runtime: BrowserRuntime;
  /**
   * The recorded run of both sides, for a page that cannot run them: each side shows its side's run, and Run
   * both becomes "Run in a new tab" (or goes when the browser itself cannot run).
   */
  recorded?: {
    sides: readonly [RecordedRunResult, RecordedRunResult];
    recordedAt: string;
    reason: RecordedReason;
    recordedBy: RecordedBy;
  };
  /** Called each time a side's run settles, such as each side of Run both. A recorded run shown here never calls it. */
  onRunSettled?: (settled: RunOutcome, side: PairSideIndex) => void;
}

const READ_ONLY = "This embed is read only. Open the full playground to edit the code.";
/** The editors' line height and Monaco's top padding, plus room under the last line. */
const CODE_LINE = 22;
const CODE_PADDING = 18 + 10;
const MAX_CODE_LINES = 14;
const viewLabels: Record<EmbedSideView, string> = { results: "Results", story: "Story", logs: "Logs" };
const dotGrid = "bg-[radial-gradient(var(--dot)_1px,transparent_1.2px)] bg-size-[18px_18px]";
const pillText: Record<SidePill["tone"], string> = {
  idle: "text-muted",
  running: "text-text",
  ok: "text-ok",
  err: "text-err",
};
const chipTones: Record<SidePill["tone"], string> = {
  idle: "bg-surface-2 text-muted",
  running: "bg-mark text-text",
  ok: "bg-ok-bg text-ok",
  err: "bg-err-bg text-err",
};

/** Spins in place of the play icon, sized like it so the button keeps its width. */
function Spinner() {
  return (
    <span
      className="size-3 shrink-0 rounded-full border-2 border-on-lime/25 border-t-on-lime motion-safe:animate-spin"
      aria-hidden="true"
    />
  );
}

/**
 * An embedded side-by-side share, read only: Run both runs each side in its own fresh runtime and
 * each side shows its own code and output. Nothing compares the sides. Under 760 px one side shows
 * at a time behind a side switch; from 760 px both sides stand in two columns.
 */
export function SideBySideEmbed({ project, playgroundHref, runtime, recorded, onRunSettled }: SideBySideEmbedProps) {
  const manifest = project.manifest;
  const [seedProblem, setSeedProblem] = useState("");
  const files = listPairFiles(manifest);
  const [selected, setSelected] = useState(manifest.entrypoints.run ?? manifest.entrypoints.schema);
  const wide = useMediaQuery(EMBED_TWO_COLUMNS_QUERY);
  const releases = getSideReleases(manifest);
  const dialect = formatProjectDialects(manifest);
  const codeLines = Math.max(
    ...PAIR_SIDES.flatMap((side) =>
      Object.values(pairSide(manifest, side).files).map((code) => code.split("\n").length),
    ),
  );
  const codeHeight = Math.min(codeLines, MAX_CODE_LINES) * CODE_LINE + CODE_PADDING;

  const sideOptions = (side: PairSideIndex) => ({
    side,
    projectId: project.id,
    manifest: pairSide(manifest, side),
    current: () => ({ manifest: pairSide(manifest, side), selected }),
    onEdit: () => undefined,
    onNavigate: setSelected,
    runtime: side === 0 ? runtime : undefined,
  });
  const first = useSide(sideOptions(0));
  const second = useSide(sideOptions(1));
  const sides = [first, second] as const;

  useLayoutEffect(() => {
    if (recorded === undefined) {
      return;
    }

    for (const side of PAIR_SIDES) {
      const execution = side === 0 ? first.execution : second.execution;

      if (execution.getState().history.length === 0) {
        execution.replay({
          submission: { manifest: pairSide(manifest, side), revision: project.revision, debug: false },
          result: recorded.sides[side],
        });
      }
    }
  }, [first.execution, second.execution, manifest, project.revision, recorded]);
  const runSide = useEffectEvent(
    ({ side, signal, runtime: sideRuntime }: { side: PairSideIndex; signal: AbortSignal; runtime: Executor }) =>
      sides[side].run(pairSide(manifest, side), project.revision, signal, { runtime: sideRuntime }),
  );
  // Built once from the effect events alone: a closure made in render would keep that render, and the editor sessions
  // it saw, alive as long as the machine.
  const getManifest = useEffectEvent(() => manifest);
  const getRuntime = useEffectEvent(() => runtime);
  const pairRun = useRuntimeComparisonController({
    getRuntime,
    runSide,
    getManifest,
    execution: getRuntimePolicy(globalThis.navigator).execution,
  });

  const pairRunning = useControllerSelector(
    pairRun,
    (state) => state.status === "running" || state.status === "disposing",
  );
  const [shown, setShown] = useState<PairSideIndex>(0);
  const [views, setViews] = useState<readonly [EmbedSideView, EmbedSideView]>(["results", "results"]);

  const reportRunSettled = useEffectEvent((settled: RunOutcome, side: PairSideIndex) => onRunSettled?.(settled, side));

  useEffect(() => {
    const subscriptions = PAIR_SIDES.map((side) =>
      (side === 0 ? first.execution : second.execution).onSettled((settled) => {
        setViews((current) =>
          side === 0
            ? [getEmbedViewAfterRun(settled.opens, current[0]), current[1]]
            : [current[0], getEmbedViewAfterRun(settled.opens, current[1])],
        );
        reportRunSettled(settled, side);
      }),
    );

    return () => subscriptions.forEach((subscription) => subscription.unsubscribe());
  }, [first.execution, second.execution]);

  useEffect(() => {
    first.session?.select(selected);
    second.session?.select(selected);
  }, [first.session, second.session, selected]);

  useEffect(() => {
    for (const session of [first.session, second.session]) {
      session?.setTextSize(12.5, 22);
      session?.setWordWrap(true);
      session?.setReadOnly(true, READ_ONLY);
    }
  }, [first.session, second.session]);

  const bothReady = first.editorReady && second.editorReady;
  const unavailable = sides.some((side) => side.ready.matches("failed") || side.ready.matches("unsupported"));
  const failedSides = sides.filter((side) => side.ready.matches("failed"));
  const canRun = bothReady && manifest.entrypoints.run !== undefined;
  const preparingLabel = (side: SidePlayground) =>
    recorded !== undefined || side.editorReady
      ? undefined
      : side.ready.matches("failed") || side.ready.matches("unsupported")
        ? "Runtime unavailable"
        : "Preparing";

  const runBoth = () => {
    if (!canRun) {
      return;
    }

    setSeedProblem("");
    void pairRun.submit({ requester: "embed" }).catch((cause) => setSeedProblem(String(cause)));
  };

  const setView = (side: PairSideIndex, view: EmbedSideView) =>
    setViews((current) => (side === 0 ? [view, current[1]] : [current[0], view]));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header
        className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-border px-2.5 py-2 data-wide:pl-3.5"
        data-wide={wide || undefined}
      >
        {wide ? (
          <>
            <span className="inline-flex shrink-0 items-center gap-1.5 font-display text-[14px] font-extrabold tracking-[-0.02em] whitespace-nowrap">
              <LogoTile small />
              <span>
                Drizzle <span className="rounded-[3px] bg-lime px-1 text-on-lime">Run</span>
              </span>
            </span>
            <span className="shrink-0 text-[13px] whitespace-nowrap text-muted">Side by side · {dialect}</span>
            <div className="ml-2 min-w-0 scrollbar-none overflow-x-auto">
              <FileTabs files={files} selected={selected} onSelect={setSelected} />
            </div>
          </>
        ) : (
          <SideSwitch
            sides={sides}
            releases={releases}
            preparing={sides.map(preparingLabel)}
            shown={shown}
            onShow={setShown}
          />
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2.5">
          <a
            className="text-[13px] font-medium whitespace-nowrap text-accent-text hover:text-text"
            href={playgroundHref}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open full playground
          </a>
          {recorded !== undefined ? (
            recorded.reason === "embedding_context_unsupported" && <RunInNewTabLink href={playgroundHref} />
          ) : (
            <Hint content={pairRunning ? "Stops both sides" : "Runs both sides, each in a fresh runtime"}>
              <Button
                variant="run"
                size="run"
                data-state={pairRunning ? "running" : bothReady || unavailable ? "ready" : "preparing"}
                className="relative h-9 min-w-28 justify-center gap-2 rounded-[9px] pr-3.5 pl-3 after:absolute after:inset-[-5.5px] max-phone:h-9 [&>svg]:size-3"
                disabled={!pairRunning && !canRun}
                aria-busy={(!pairRunning && !bothReady && !unavailable) || undefined}
                onClick={pairRunning ? () => pairRun.cancel() : runBoth}
              >
                {pairRunning ? (
                  <RunButtonIcon state="running" />
                ) : !bothReady && !unavailable ? (
                  <Spinner />
                ) : (
                  <PlayIcon aria-hidden="true" />
                )}
                {pairRunning ? "Cancel" : "Run both"}
              </Button>
            </Hint>
          )}
        </span>
      </header>
      {seedProblem && (
        <p role="alert" className="shrink-0 border-b border-border bg-err-bg px-3.5 py-2 text-[13px] text-err">
          {seedProblem}
        </p>
      )}
      {!wide && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-2.5 py-1.5">
          <span className="@container flex min-w-0 shrink-100">
            <SideReleaseChip release={releases[shown]} />
          </span>
          <EmbedFileTabs files={files} selected={selected} onSelect={setSelected} />
        </div>
      )}
      {recorded !== undefined && (
        <RecordedNote recordedAt={recorded.recordedAt} reason={recorded.reason} recordedBy={recorded.recordedBy} />
      )}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col bg-bg p-2.5",
          wide && "grid grid-cols-2 grid-rows-[minmax(0,1fr)] gap-2.5",
        )}
      >
        {sides.map((side) => (
          <RunProvider key={side.side} controller={side.execution}>
            <EmbedSidePane
              side={side}
              release={releases[side.side]}
              files={pairSide(manifest, side.side).files}
              dialect={pairSide(manifest, side.side).target.dialect}
              selected={selected}
              codeHeight={codeHeight}
              wide={wide}
              hidden={!wide && side.side !== shown}
              preparing={preparingLabel(side)}
              view={views[side.side]}
              onView={(view) => setView(side.side, view)}
              onSource={(path, line) => {
                setSelected(path);
                side.session?.select(path, line, 1);
              }}
            />
          </RunProvider>
        ))}
      </div>
      {recorded === undefined && failedSides.length > 0 && (
        <PreparationFailedDialog
          error={failedSides[0]?.ready.context.error}
          note="Reload the page to try again later."
          onRetry={() => {
            for (const side of failedSides) {
              side.readiness.send({ type: "readiness.retry" });
            }
          }}
        />
      )}
    </div>
  );
}

interface SideSwitchProps {
  sides: readonly SidePlayground[];
  releases: readonly [SideRelease, SideRelease];
  /** Each side's pill label before a first run while its runtime is not ready. */
  preparing: readonly (string | undefined)[];
  shown: PairSideIndex;
  onShow: (side: PairSideIndex) => void;
}

/** One side at a time: each tab names its side and says how it ran. */
function SideSwitch({ sides, releases, preparing, shown, onShow }: SideSwitchProps) {
  return (
    <div
      className="flex shrink-0 gap-0.5 rounded-[9px] bg-surface-2 p-0.75 max-[479px]:w-full"
      role="tablist"
      aria-label="Side"
    >
      {sides.map((side) => (
        <RunProvider key={side.side} controller={side.execution}>
          <SideSwitchTab
            label={releases[side.side].label}
            preparing={preparing[side.side]}
            selected={side.side === shown}
            onSelect={() => onShow(side.side)}
          />
        </RunProvider>
      ))}
    </div>
  );
}

interface SideSwitchTabProps {
  label: string;
  preparing: string | undefined;
  selected: boolean;
  onSelect: () => void;
}

/** A side's tab in the switch, with how its run went; reads the run from the closest `RunProvider`. */
function SideSwitchTab({ label, preparing, selected, onSelect }: SideSwitchTabProps) {
  const { run, pill } = useSideStatus(preparing);
  const ran = run.running || run.outcome !== undefined;

  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className="relative inline-flex h-7.5 items-center justify-center gap-1.5 rounded-[6px] border-0 bg-transparent px-2.5 text-text after:absolute after:inset-x-0 after:-inset-y-1.75 aria-selected:bg-surface aria-selected:shadow-[0_0_0_1px_var(--border)] max-[479px]:flex-1"
      onClick={onSelect}
    >
      <b className="max-w-40 truncate text-[12.5px] font-semibold">{label}</b>
      {ran && (
        <span className={cn("text-[11.5px] font-semibold whitespace-nowrap", pillText[pill.tone])}>
          {pill.label}
          {pill.duration !== undefined && (
            <span className="whitespace-pre" data-duration="">
              {pill.tone === "ok" ? " " : " · "}
              {pill.duration}
            </span>
          )}
        </span>
      )}
    </button>
  );
}

/** The narrow embed's file tabs, beside the shown side's pair. */
function EmbedFileTabs({
  files,
  selected,
  onSelect,
}: {
  files: readonly string[];
  selected: string;
  onSelect: (path: string) => void;
}) {
  return (
    <Segmented
      className="ml-auto min-w-0 scrollbar-none overflow-x-auto"
      value={selected}
      onValueChange={(value) => {
        if (typeof value === "string") {
          onSelect(value);
        }
      }}
    >
      <SegmentedList
        aria-label="Project files"
        className="gap-0.5 bg-transparent p-0"
        indicatorClassName="rounded-base bg-segment shadow-none"
      >
        {files.map((path) => (
          <SegmentedItem
            key={path}
            value={path}
            className="relative h-7 rounded-base px-2.5 py-0 font-mono text-[12px] text-muted after:absolute after:inset-x-0 after:-inset-y-2 data-active:font-semibold data-active:text-segment-fg"
          >
            {path}
          </SegmentedItem>
        ))}
      </SegmentedList>
    </Segmented>
  );
}

/** A side's database, release and versions, in the app's pane-head chip; the embed cannot change them. */
function SideReleaseChip({ release }: { release: SideRelease }) {
  return (
    <span className="inline-flex h-6 min-w-0 shrink-100 items-center gap-1.5 rounded-[6px] border border-border bg-surface-2 py-0 pr-1.75 pl-2 text-[12px] whitespace-nowrap text-text">
      <SideReleaseText release={release} />
    </span>
  );
}

interface EmbedSidePaneProps {
  side: SidePlayground;
  release: SideRelease;
  files: Readonly<Record<string, string>>;
  dialect: RunManifestTarget["dialect"];
  selected: string;
  codeHeight: number;
  wide: boolean;
  hidden: boolean;
  /** The pill's label before a first run while the side's runtime is not ready. */
  preparing: string | undefined;
  view: EmbedSideView;
  onView: (view: EmbedSideView) => void;
  onSource: (path: string, line: number) => void;
}

/**
 * One side, as the app draws it: a code card with its head (wide) and an output card with its own Results, Story
 * and Logs. It reads the side's run from the
 * closest `RunProvider`.
 */
function EmbedSidePane({
  side,
  release,
  files,
  dialect,
  selected,
  codeHeight,
  wide,
  hidden,
  preparing,
  view,
  onView,
  onSource,
}: EmbedSidePaneProps) {
  const { run, pill } = useSideStatus(preparing);
  const { attachHost, editorReady } = side;

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5"
      aria-label={`${release.label} side`}
      hidden={hidden}
    >
      <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-code">
        {wide && (
          <div className="@container flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface pr-2.5 pl-3">
            <b className="max-w-50 shrink-0 truncate text-[13px] font-semibold">{release.label}</b>
            <SideReleaseChip release={release} />
            <span className="flex-1" />
            <span className="inline-flex h-5 items-center gap-1.25 rounded-pill bg-surface-2 px-2 text-[11px] font-semibold whitespace-nowrap text-muted">
              <LockIcon className="size-2.75 stroke-[2.2]" aria-hidden="true" />
              <span className="@max-[30rem]:sr-only">Read only</span>
            </span>
            <SidePillChip pill={pill} />
          </div>
        )}
        <div className="relative min-h-30" style={{ height: codeHeight }}>
          <div
            ref={attachHost}
            className="size-full min-h-0"
            style={{ visibility: editorReady ? "visible" : "hidden" }}
          />
          {!editorReady && (
            <div className="absolute inset-0 flex flex-col bg-code text-[13px] text-muted">
              <CodePreview code={files[selected] ?? ""} />
            </div>
          )}
        </div>
      </div>
      <section
        className={cn(
          "flex min-h-70 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-surface",
          dotGrid,
        )}
        aria-label={`${release.label} output`}
      >
        <Segmented
          className="flex min-h-0 flex-1 flex-col"
          value={view}
          onValueChange={(value) => {
            const picked = EMBED_SIDE_VIEWS.find((item) => item === value);

            if (picked) {
              onView(picked);
            }
          }}
        >
          <div
            className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-2.5 py-1.5 data-narrow:py-2"
            data-narrow={!wide || undefined}
          >
            <SegmentedList
              aria-label={`${release.label} output`}
              className="gap-0.5 bg-transparent p-0"
              indicatorClassName="rounded-base bg-segment shadow-none"
            >
              {EMBED_SIDE_VIEWS.map((item) => (
                <SegmentedItem
                  key={item}
                  value={item}
                  className="relative inline-flex h-7 items-center gap-1.5 rounded-base px-2.5 py-0 text-[12.5px] text-muted after:absolute after:inset-x-0 after:-inset-y-2 data-active:font-semibold data-active:text-segment-fg"
                >
                  {viewLabels[item]}
                  {run.ran && item !== "story" && run.counts[item] > 0 && (
                    <ViewCount view={item}>{run.counts[item]}</ViewCount>
                  )}
                </SegmentedItem>
              ))}
            </SegmentedList>
            {!wide && <OutputStatus pill={pill} label={release.label} />}
          </div>
          {EMBED_SIDE_VIEWS.map((item) => (
            <SegmentedPanel key={item} value={item} className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto p-3">
              <SideOutputBody
                run={run}
                tab={item}
                short={release.short}
                firstRun={{ status: getSideFirstRunStatus(side), dialect }}
                onDiagnostic={(diagnostic) => {
                  if (diagnostic.source !== undefined && files[diagnostic.source] !== undefined) {
                    onSource(diagnostic.source, diagnostic.line ?? 1);
                  }
                }}
              />
            </SegmentedPanel>
          ))}
        </Segmented>
      </section>
    </section>
  );
}

function ViewCount({ view, children }: { view: EmbedSideView; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-grid h-4.5 min-w-4.5 place-items-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums",
        view === "results"
          ? "bg-lime text-on-lime"
          : "bg-surface-2 text-muted in-data-active:bg-segment-fg/20 in-data-active:text-segment-fg",
      )}
    >
      {children}
    </span>
  );
}

/** The narrow embed's run status for the shown side, such as "✓ rc.5 · 191 ms". */
function OutputStatus({ pill, label }: { pill: SidePill; label: string }) {
  const status =
    pill.tone === "ok"
      ? `✓ ${label}`
      : pill.tone === "err"
        ? `${label} failed`
        : pill.tone === "running"
          ? `Running ${label}`
          : pill.label;

  return (
    <output
      className={cn(
        "ml-auto inline-flex h-5.5 shrink-0 items-center rounded-pill px-2 text-[12px] font-semibold whitespace-nowrap",
        chipTones[pill.tone],
      )}
    >
      {status}
      {pill.duration !== undefined && (
        <span className="whitespace-pre" data-duration="">
          {" "}
          · {pill.duration}
        </span>
      )}
    </output>
  );
}
