import { DIALECTS, type GuestFlavor, type RuntimeTupleId } from "@drizzle-run/core/catalog";
import type { Diagnostic, Executor } from "@drizzle-run/core/contracts";
import { isSharedPairFile, otherSide, pairSide, type PairSideFiles, type PairSideIndex } from "@drizzle-run/core/pair";
import { type PairSideInput } from "@drizzle-run/orchestration";
import { useRuntimeComparisonController, useControllerSelector } from "@drizzle-run/react";
import { type PairRunResult } from "@drizzle-run/runtime/machines";
import { useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { EDITOR_TEXT } from "../design/editor-font-size";
import { resolveDiagnosticFile } from "../editor/diagnostics";
import { useErrorFiles } from "../editor/use-error-files";
import { getErrorText } from "../lib/error-text";
import { getRuntimePolicy } from "../lib/runtime-policy";
import { toEditRefusalText } from "../project/edit-refusal";
import {
  applySideHelperOperation,
  changeSideVersion,
  renameSide,
  editProject,
  editSideFile,
  isSideBySide,
  shareSideFile,
  splitSideFile,
  swapSides,
  type SideBySideProject,
} from "../project/projects";
import { requestPairRun } from "../project/run-request";
import { getSharedRuntime } from "../project/shared-runtime";
import { useLeaveGuard, useUnloadWarning } from "../ui/leave-guard";
import type { OutputTab } from "../ui/output-tab";
import type { RunButtonState } from "../ui/run-button";
import { useEditorFontSize } from "../ui/use-editor-font-size";
import { PHONE_QUERY, useMediaQuery } from "../ui/use-media-query";
import { toChatProject } from "../workspace/chat";
import { isFormatOnRun } from "../workspace/format-on-run-setting";
import { useHelperFileDialog } from "../workspace/helper-file-dialog";
import { shouldWarnOnUnload } from "../workspace/save-state";
import { getFileRoles, useSeedSwitch } from "../workspace/seed-switch";
import { useRememberedFile } from "../workspace/use-remembered-file";
import { useRunOptions } from "../workspace/use-run-options";
import { useShareDialog } from "../workspace/use-share-dialog";
import { useWorkspaceChat, useWorkspaceConnectHost } from "../workspace/use-workspace-chat";
import { useWorkspaceView } from "../workspace/use-workspace-view";
import { resolveViewProject } from "../workspace/view-project";
import { resolveWorkspaceLayoutMode } from "../workspace/workspace-layout";
import type { SideBySideViewProps } from "./side-by-side-view";
import { getSideReleases, listPairFiles } from "./side-labels";
import type { SideTab } from "./side-output";
import { useSide, type SidePlayground } from "./use-side";

/** Font size and line height in pixels for a side's desktop editor. */
const SIDE_TEXT = { fontSize: 12.5, lineHeight: 22 } as const;

/**
 * Side-by-side workspace controller
 *
 * The state, effects and handlers of `SideBySideView`: both sides' editors and runtimes, the open file, the pair run
 * and a guide's runs through `control`, the file and side actions, the AI chat host, and what a phone shows. The
 * view only renders what this returns.
 */
export function useSideBySideWorkspace({
  project,
  storage,
  update,
  saveState,
  unsavedCopy = false,
  warnOnLeave,
  reportError,
  readOnly,
  aside,
  fileOverride,
  highlight,
  onRunRequest,
  runDisabled,
  control,
  connect,
  rememberedFile,
}: SideBySideViewProps) {
  const [, setSearch] = useSearchParams();
  const manifest = project.manifest;
  const files = listPairFiles(manifest);
  const defaultFile = manifest.entrypoints.run ?? manifest.entrypoints.schema;
  const { selected, chooseFile } = useRememberedFile({
    projectId: project.id,
    storage,
    defaultFile,
    rememberedFile,
    hasFile: (path) => files.includes(path),
    reportError,
  });
  const phone = useMediaQuery(PHONE_QUERY);
  const preferredFontSize = useEditorFontSize();
  const releases = getSideReleases(manifest);
  // Handlers and the pair run read the latest props here; an edit writes its project here before the save renders.
  const latest = useRef({ project, update, selected, sides: [] as SidePlayground[] });
  const submittedProject = useRef(project);
  // The projects this view saved, so a project from elsewhere, such as another tab, is never taken for an older save.
  const ownSaves = useRef(new WeakSet<SideBySideProject>());

  /** Makes `next` the view's project and saves it. */
  const save = (next: SideBySideProject) => {
    latest.current.project = next;
    ownSaves.current.add(next);
    latest.current.update(next);
  };
  const { seedPath, toggleSeed } = useSeedSwitch({
    entrypoints: manifest.entrypoints,
    canSeed: (path) => isSharedPairFile(latest.current.project.manifest, path),
    onChange: (entrypoints) => {
      const current = latest.current.project;

      runAction(() => editProject(current, { ...current.manifest, entrypoints }));
    },
    reportError,
  });

  /** Saves `next` and writes what changed into each side's editor. */
  const apply = (next: SideBySideProject) => {
    save(next);

    for (const side of latest.current.sides) {
      side.session?.replaceFiles(pairSide(next.manifest, side.side).files);
    }
  };

  const onEdit = (side: PairSideIndex, path: string, content: string) => {
    const current = latest.current.project;
    const saved = pairSide(current.manifest, side).files[path];

    // A shared file written into the other editor echoes back; it is already saved.
    if (saved === content) {
      return;
    }

    try {
      const next = editSideFile(current, side, path, content);

      save(next);

      if (isSharedPairFile(next.manifest, path)) {
        latest.current.sides[otherSide(side)]?.session?.replaceFiles({ [path]: content });
      }
    } catch (cause) {
      // After the edit event, as Monaco is still applying the edit.
      if (saved !== undefined) {
        queueMicrotask(() => latest.current.sides[side]?.session?.replaceFiles({ [path]: saved }));
      }

      reportError(toEditRefusalText(cause));
    }
  };

  const openHighlightedFile = useEffectEvent((side: PairSideIndex, file: string) => {
    const firstMarkedSide = highlight?.sides.findIndex((mark) => mark !== undefined);

    if (side !== firstMarkedSide) {
      return;
    }

    const params = new URLSearchParams(window.location.search);

    if (listPairFiles(latest.current.project.manifest).includes(file) && params.get("file") !== file) {
      params.set("file", file);
      setSearch(params, { replace: true });
    }
  });
  const runOptions = useRunOptions();
  const sideOptions = (side: PairSideIndex) => ({
    side,
    projectId: project.id,
    manifest: pairSide(manifest, side),
    current: () => ({ manifest: pairSide(latest.current.project.manifest, side), selected: latest.current.selected }),
    onEdit,
    onNavigate: chooseFile,
    onMarkFile: (markedSide: PairSideIndex, path: string) => openHighlightedFile(markedSide, path),
  });
  const first = useSide(sideOptions(0));
  const second = useSide(sideOptions(1));
  const sides = [first, second] as const;

  useLayoutEffect(() => {
    latest.current.update = update;
    latest.current.selected = selected;
    latest.current.sides = [first, second];

    latest.current.project = resolveViewProject({
      rendered: project,
      current: latest.current.project,
      isOwnSave: ownSaves.current.has(project),
    });
  });

  // A project saved elsewhere, such as in another tab, reaches the editors; the view's own edits are already there.
  // An edit typed since the render wrote a newer project to `latest`, so it is never rolled back.
  useEffect(() => {
    const edited = latest.current.project;
    const newest = edited.id === project.id && edited.revision > project.revision ? edited : project;

    for (const side of latest.current.sides) {
      side.session?.replaceFiles(pairSide(newest.manifest, side.side).files);
    }
  }, [latest, project]);

  const runSide = useEffectEvent(
    ({ side, signal, manifest: requested, runtime }: PairSideInput & { runtime: Executor }) => {
      const current = submittedProject.current;
      const playground = latest.current.sides[side];

      if (playground === undefined) {
        return Promise.resolve("failed" as const);
      }

      return playground.run(pairSide(requested ?? current.manifest, side), current.revision, signal, {
        ...runOptions.read(),
        runtime,
      });
    },
  );
  /**
   * Formats both sides with Prettier before their run; each side's run then reads `latest`, which every format edit
   * writes at once. One side after the other: the first formats the shared files, which reach the second through its
   * mirror, so the second formats only its own. A format that fails leaves the code as it is.
   */
  const formatSides = useEffectEvent(async (signal: AbortSignal) => {
    try {
      const sharedPaths = new Set(Object.keys(latest.current.project.manifest.files));

      await first.session?.formatFiles(signal);
      await second.session?.formatFiles(signal, first.session === undefined ? {} : { skip: sharedPaths });
    } catch (cause) {
      console.error("Could not format the sides before their run", cause);
    }
  });
  // Built once from the effect events alone: a closure made in render would keep that render, and the editor sessions
  // it saw, alive as long as the machine.
  const getManifest = useEffectEvent(() => latest.current.project.manifest);
  const acquireRuntime = useEffectEvent(() => {
    // The controller accepts one comparison at a time; both histories retain its pre-acquisition revision.
    submittedProject.current = latest.current.project;

    return getSharedRuntime();
  });
  const getQueryPlans = useEffectEvent(() => runOptions.read().queryPlans);
  const pairRun = useRuntimeComparisonController({
    getRuntime: acquireRuntime,
    getQueryPlans,
    runSide,
    getManifest,
    execution: getRuntimePolicy(globalThis.navigator).execution,
  });
  const pairRunning = useControllerSelector(
    pairRun,
    (state) => state.status === "running" || state.status === "disposing",
  );
  const view = useWorkspaceView({ asideView: aside !== undefined && !aside.sheet, afterRun: "output" });
  const { send: sendView } = view;
  const [tabs, setTabs] = useState<readonly [SideTab, SideTab]>(["results", "results"]);
  const [changing, setChanging] = useState<PairSideIndex | undefined>(undefined);

  // A run hides the version popover without closing it, so it would open again when the pair settles.
  if (pairRunning && changing !== undefined) {
    setChanging(undefined);
  }
  const { openShare, openPush, shareStatus, shareDialog } = useShareDialog({
    project,
    links: storage,
    executions: [first.execution, second.execution],
  });

  useEffect(() => {
    const subscription = pairRun.onSettled(({ outcomes }) => {
      if (outcomes.some((outcome) => outcome !== "cancelled")) {
        sendView({ type: "run.settled", phone });
      }
    });

    return () => subscription.unsubscribe();
  }, [pairRun, phone, sendView]);

  const leaveBlocker = useLeaveGuard(unsavedCopy);

  useUnloadWarning(warnOnLeave ?? shouldWarnOnUnload({ saveState, unsavedCopy }));

  useEffect(() => {
    first.session?.select(selected);
    second.session?.select(selected);
  }, [first.session, second.session, selected]);

  useEffect(() => {
    for (const session of [first.session, second.session]) {
      if (phone) {
        session?.setPhoneLayout(true);
      } else {
        session?.setTextSize(SIDE_TEXT.fontSize, SIDE_TEXT.lineHeight);
      }

      session?.setPreferredFontSize(preferredFontSize);
      session?.setReadOnly(readOnly !== undefined, readOnly ?? "");
    }
  }, [first.session, second.session, phone, preferredFontSize, readOnly]);

  useEffect(() => {
    if (!fileOverride) {
      return;
    }

    for (const side of [first, second]) {
      side.editorCommands.send({
        type: "command.add",
        command: {
          kind: "files",
          version: fileOverride.version,
          files: pairSide(fileOverride.manifest, side.side).files,
        },
      });
    }
  }, [fileOverride, first, second]);

  useEffect(() => {
    if (!highlight) {
      return;
    }

    for (const side of [first, second]) {
      const mark = highlight.sides[side.side];

      if (mark) {
        side.editorCommands.send({
          type: "command.add",
          command: { kind: "highlight", version: highlight.version, ...mark, open: true, reveal: false },
        });
      }
    }
  }, [highlight, first, second]);

  useImperativeHandle(
    control,
    () => ({
      run: async (submitted, signal) => {
        if (!first.editorReady || !second.editorReady) {
          throw new Error("The playground cannot start a run right now.");
        }

        const settled = await requestPairRun(pairRun, { requester: "guide", manifest: submitted, signal });
        const [left, right] = settled.runs;

        if (left.result && right.result) {
          return [left.result, right.result] satisfies PairRunResult;
        }

        throw new Error(left.error ?? right.error ?? "The run stopped before both sides returned a result.");
      },
    }),
    [first.editorReady, second.editorReady, pairRun],
  );

  useWorkspaceConnectHost({
    connect,
    runOptions,
    build: () => ({
      project: () => latest.current.project,
      save: (next) => {
        if (!isSideBySide(next)) {
          throw new Error("This view holds a side-by-side project.");
        }

        apply(next);
      },
      problems: () =>
        latest.current.sides.flatMap((side) =>
          (side.session?.problems() ?? []).map((problem) => ({ ...problem, side: side.side })),
        ),
      latestRun: (side) => latest.current.sides[side]?.execution.getState().result,
      running: () => pairRun.getState().status === "running",
      run: async () => {
        const current = latest.current.project.manifest;

        if (!latest.current.sides.every((side) => side.editorReady) || current.entrypoints.run === undefined) {
          throw new Error("The project cannot run right now: a side is preparing. Try again in a moment.");
        }

        await requestPairRun(pairRun, { requester: "agent" });
      },
    }),
  });

  const bothReady = first.editorReady && second.editorReady;
  const unavailable = sides.some((side) => side.ready.matches("failed") || side.ready.matches("unsupported"));
  const failedSides = sides.filter((side) => side.ready.matches("failed"));
  const unsupported = sides.find(
    (side) => side.ready.matches("unsupported") && side.ready.context.capabilities !== undefined,
  );
  const capabilities = unsupported?.ready.context.capabilities;
  const canRun = bothReady && !runDisabled && manifest.entrypoints.run !== undefined;

  const startRun = () => {
    if (!canRun) {
      return;
    }

    if (onRunRequest) {
      onRunRequest();
      return;
    }

    void pairRun
      .submit({
        requester: "view",
        ...(isFormatOnRun() ? { prepare: (signal: AbortSignal) => formatSides(signal) } : {}),
      })
      .catch((cause) => reportError(String(cause)));
  };

  const diagnostic = (side: SidePlayground) => (item: Diagnostic) => {
    const path = resolveDiagnosticFile(item.source, files);

    if (path && side.session) {
      chooseFile(path);
      side.session.select(path, item.line ?? 1, item.column ?? 1);

      if (phone) {
        sendView({ type: "code.show", side: side.side });
      }
    }
  };

  const selectedPerSide = !isSharedPairFile(manifest, selected);
  const fileRoles = getFileRoles({
    entrypoints: manifest.entrypoints,
    seedPath,
    selected,
    hasFile: (path) => files.includes(path),
  });

  const runAction = (operation: () => SideBySideProject) => {
    try {
      apply(operation());
    } catch (cause) {
      reportError(getErrorText(cause));
    }
  };
  const { openCreate, openRename, openDelete, helperFileDialog } = useHelperFileDialog({
    sides: 2,
    selected,
    onSubmit: ({ action, path, filename }) => {
      apply(applySideHelperOperation(latest.current.project, action, path, filename));
      chooseFile(action === "delete" ? defaultFile : filename);
    },
  });

  const { chat, chatOpen, setChatOpen, pendingPaths, workspaceChat } = useWorkspaceChat({
    connect,
    project: toChatProject(project, [
      {
        side: 0,
        name: releases[0].label,
        orm: manifest.sides[0].dependencies["drizzle-orm"],
        database: DIALECTS[manifest.sides[0].target.dialect].label,
      },
      {
        side: 1,
        name: releases[1].label,
        orm: manifest.sides[1].dependencies["drizzle-orm"],
        database: DIALECTS[manifest.sides[1].target.dialect].label,
      },
    ]),
    files,
    shown: !phone && !capabilities,
  });

  const showOutput = (tab: OutputTab) => {
    setTabs([tab, tab]);

    if (phone) {
      sendView({ type: "output.show", side: view.side });
    }
  };
  const runState: RunButtonState = pairRunning ? "running" : bothReady || unavailable ? "ready" : "preparing";
  const firstErrors = useErrorFiles(first.session);
  const secondErrors = useErrorFiles(second.session);
  const errorFiles = new Map(
    files.flatMap((path): [string, string][] => {
      const onFirst = firstErrors.has(path);
      const onSecond = secondErrors.has(path);

      if (onFirst && onSecond) {
        return [[path, "TypeScript errors on both sides"]];
      }

      return onFirst || onSecond ? [[path, `TypeScript errors on ${releases[onFirst ? 0 : 1].label}`]] : [];
    }),
  );
  const asideContent = aside?.renderContent({ phone, runState, canRun, run: startRun, showOutput });

  return {
    mode: resolveWorkspaceLayoutMode({ phone, compact: false }),
    asideContent,
    phone,
    view,
    sides,
    releases,
    files,
    selected,
    chooseFile,
    selectedPerSide,
    seedPath,
    toggleSeed,
    fileRoles,
    pendingPaths,
    errorFiles,
    openCreate,
    openRename,
    openDelete,
    helperFileDialog,
    openShare,
    openPush,
    shareStatus,
    shareDialog,
    leaveBlocker,
    runOptions,
    pairRunning,
    bothReady,
    unavailable,
    canRun,
    startRun,
    cancelRun: () => {
      void pairRun.cancel().catch((cause) => reportError(getErrorText(cause)));
    },
    failedSides,
    /** The side whose capability check says this browser cannot run it, with its report. */
    unsupported: unsupported && capabilities ? { side: unsupported, capabilities } : undefined,
    diagnostic,
    tabs,
    setSideTab: (side: PairSideIndex, tab: SideTab) =>
      setTabs((current) => (side === 0 ? [tab, current[1]] : [current[0], tab])),
    changing,
    setChanging,
    changeSide: (side: PairSideIndex, tupleId: RuntimeTupleId, sideFiles: PairSideFiles, guestFlavor: GuestFlavor) => {
      setChanging(undefined);
      runAction(() => changeSideVersion(latest.current.project, side, tupleId, sideFiles, guestFlavor));
    },
    swapSides: () => runAction(() => swapSides(latest.current.project)),
    renameSide: (side: PairSideIndex, name: string) => runAction(() => renameSide(latest.current.project, side, name)),
    shareSideFile: (side: PairSideIndex) => runAction(() => shareSideFile(latest.current.project, selected, side)),
    splitSideFile: () => runAction(() => splitSideFile(latest.current.project, selected)),
    chat,
    chatOpen,
    setChatOpen,
    workspaceChat,
    defaultFontSize: phone ? EDITOR_TEXT.phone.fontSize : SIDE_TEXT.fontSize,
  };
}
