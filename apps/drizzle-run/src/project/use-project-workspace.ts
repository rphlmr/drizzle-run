import { listSupportedTuples } from "@drizzle-run/core/catalog";
import type { Diagnostic } from "@drizzle-run/core/contracts";
import type { RunManifest } from "@drizzle-run/core/manifest";
import { type RunCode } from "@drizzle-run/orchestration";
import { useRunController, useControllerSelector } from "@drizzle-run/react";
import type { createBrowserRuntime } from "@drizzle-run/runtime/browser";
import {
  createReleaseSwitchMachine,
  preparationPercent,
  type ReleaseSwitchRequest,
} from "@drizzle-run/runtime/machines";
import { useActorRef, useSelector } from "@xstate/react";
import { useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { useConnectedAgent } from "../connect/connect-provider";
import { resolveDiagnosticFile } from "../editor/diagnostics";
import { useErrorFiles } from "../editor/use-error-files";
import { getErrorText } from "../lib/error-text";
import { useLeaveGuard, useUnloadWarning } from "../ui/leave-guard";
import { DEFAULT_OUTPUT_TAB, type OutputTab } from "../ui/output-tab";
import type { PhoneOutputBadge } from "../ui/phone-view-switch";
import { getReleaseCurrent, type ReleaseChoice } from "../ui/release-options";
import type { RunButtonState } from "../ui/run-button";
import { buildRunTimeline, countTimeline } from "../ui/run-timeline";
import { useEditorFontSize } from "../ui/use-editor-font-size";
import { PHONE_QUERY, useMediaQuery } from "../ui/use-media-query";
import { toChatProject } from "../workspace/chat";
import type { EditorSession } from "../workspace/editor-readiness";
import { isFormatOnRun } from "../workspace/format-on-run-setting";
import { useHelperFileDialog } from "../workspace/helper-file-dialog";
import { useRunMarks } from "../workspace/run-marks";
import { shouldWarnOnUnload } from "../workspace/save-state";
import { getFileRoles, useSeedSwitch } from "../workspace/seed-switch";
import { useEditorController } from "../workspace/use-editor-controller";
import { useRememberedFile } from "../workspace/use-remembered-file";
import { useRunOptions } from "../workspace/use-run-options";
import { useShareDialog } from "../workspace/use-share-dialog";
import { useWorkspaceChat, useWorkspaceConnectHost } from "../workspace/use-workspace-chat";
import { useWorkspaceView } from "../workspace/use-workspace-view";
import { resolveViewProject } from "../workspace/view-project";
import { resolveWorkspaceLayoutMode } from "../workspace/workspace-layout";
import { toEditRefusalText } from "./edit-refusal";
import type { ProjectViewProps } from "./project-view";
import {
  applyHelperOperation,
  changeVersion,
  editProject,
  getCatalogTarget,
  isOneVersion,
  orderProjectFiles,
  type OneVersionProject,
} from "./projects";
import { requestRun } from "./run-request";
import { getSharedRuntime } from "./shared-runtime";

type BrowserRuntime = ReturnType<typeof createBrowserRuntime>;

/**
 * One-version workspace controller
 *
 * The state, effects and handlers of `ProjectView`: the editor and runtime readiness, the open file, the run and the
 * host's runs through `control`, the release switch, the AI chat host, and what a phone shows. The view only renders
 * what this returns.
 */
export function useProjectWorkspace({
  project,
  storage,
  update,
  saveState,
  unsavedCopy = false,
  warnOnLeave,
  reportError,
  compact = false,
  runtime: suppliedRuntime,
  onRunSettled,
  fileOverride,
  highlight,
  releaseLocked,
  readOnly,
  onRunRequest,
  runDisabled,
  control,
  runNotes = compact ? "off" : "playground",
  stepNotes,
  aside,
  connect,
  rememberedFile,
}: ProjectViewProps) {
  const [, setSearch] = useSearchParams();
  const defaultFile = project.manifest.entrypoints.run ?? project.manifest.entrypoints.schema;
  const { selected, chooseFile: openFile } = useRememberedFile({
    projectId: project.id,
    storage,
    defaultFile,
    rememberedFile,
    hasFile: (path) => Object.hasOwn(project.manifest.files, path),
    reportError,
  });
  const { seedPath, toggleSeed } = useSeedSwitch({
    entrypoints: project.manifest.entrypoints,
    canSeed: (path) => Object.hasOwn(project.manifest.files, path),
    onChange: (entrypoints) => update(editProject(project, { ...project.manifest, entrypoints })),
    reportError,
  });

  const latest = useRef({ project, update, reportError, onRunSettled, selected });
  // The projects this view saved, so a project from elsewhere, such as another tab, is never taken for an older save.
  const ownSaves = useRef(new WeakSet<OneVersionProject>());

  /** Makes `next` the view's project and saves it. */
  const save = (next: OneVersionProject) => {
    latest.current.project = next;
    ownSaves.current.add(next);
    latest.current.update(next);
  };

  // Callbacks that outlive a render read the latest props here; an edit writes its project before the next render.
  useLayoutEffect(() => {
    latest.current = {
      project: resolveViewProject({
        rendered: project,
        current: latest.current.project,
        isOwnSave: ownSaves.current.has(project),
      }),
      update,
      reportError,
      onRunSettled,
      selected,
    };
  });

  const [checkedRuntime, setCheckedRuntime] = useState<BrowserRuntime | undefined>(undefined);
  const activeRuntime = suppliedRuntime ?? checkedRuntime;
  const execution = useRunController();
  const moveRelease = useEffectEvent(
    ({ tuple, guestFlavor }: ReleaseSwitchRequest) =>
      changeVersion(latest.current.project, tuple.ormVersion, tuple.kitVersion, guestFlavor).manifest,
  );
  const applyRelease = useEffectEvent((manifest: RunManifest) =>
    latest.current.update(editProject(latest.current.project, manifest)),
  );
  // Built once from the effect events alone: a closure made in render would keep that render, and the editor sessions
  // it saw, alive as long as the machine.
  const [releaseSwitchMachine] = useState(() => createReleaseSwitchMachine({ move: moveRelease, apply: applyRelease }));
  const releaseSwitch = useActorRef(releaseSwitchMachine, { input: { locked: releaseLocked !== undefined } });
  const running = useControllerSelector(
    execution,
    (state) => state.status === "running" || state.status === "disposing",
  );
  const switchingRelease = useSelector(
    releaseSwitch,
    (snapshot) => snapshot.matches("moving") || snapshot.matches("applying"),
  );
  const runOptions = useRunOptions();
  const { openShare, openPush, shareStatus, shareDialog } = useShareDialog({
    project,
    links: storage,
    executions: [execution],
  });
  const [releaseOpen, setReleaseOpen] = useState(false);
  const environmentKey = JSON.stringify([
    project.id,
    project.manifest.target.dialect,
    project.manifest.dependencies,
    project.manifest.guestFlavor,
    Object.keys(project.manifest.files),
  ]);
  const phone = useMediaQuery(PHONE_QUERY) && !compact;
  const mode = resolveWorkspaceLayoutMode({ phone, compact });
  const preferredFontSize = useEditorFontSize();
  const codeFontSize = compact ? null : preferredFontSize;
  const view = useWorkspaceView({ asideView: aside !== undefined && !aside.sheet, afterRun: "aside" });
  const { send: sendView } = view;
  const [outputTab, setOutputTab] = useState<OutputTab>(DEFAULT_OUTPUT_TAB);

  useEffect(() => {
    releaseSwitch.send({ type: releaseLocked === undefined ? "release.unlock" : "release.lock" });
  }, [releaseSwitch, releaseLocked]);

  useEffect(() => {
    const subscription = releaseSwitch.on("release.switch.failed", ({ error }) => {
      latest.current.reportError(error);
      releaseSwitch.send({ type: "release.dismiss" });
    });

    return () => subscription.unsubscribe();
  }, [releaseSwitch]);

  useEffect(() => {
    const subscription = execution.onSettled((event) => {
      latest.current.onRunSettled?.(event);

      if (event.outcome === "cancelled") {
        return;
      }

      sendView({ type: "run.settled", phone });
    });

    return () => subscription.unsubscribe();
  }, [execution, phone, sendView]);

  const {
    attachHost,
    readiness,
    ready,
    editorReady,
    session: readySession,
    editorCommands,
  } = useEditorController({
    environmentKey,
    runtime: suppliedRuntime,
    getSharedRuntime: () => getSharedRuntime(),
    onRuntime: setCheckedRuntime,
    readManifest: () => latest.current.project.manifest,
    openEditor: async (environment, signal, element) => {
      let session: EditorSession | undefined;

      session = await environment.prepareEditor(
        element,
        latest.current.project.manifest,
        (path, content) => {
          const currentProject = latest.current.project;
          const saved = currentProject.manifest.files[path];

          // Files written into the editor from the saved project echo back; they are already saved.
          if (saved === content) {
            return;
          }

          try {
            const edited = editProject(currentProject, {
              ...currentProject.manifest,
              files: { ...currentProject.manifest.files, [path]: content },
            });
            save(edited);
          } catch (cause) {
            // After the edit event, as Monaco is still applying the edit.
            if (saved !== undefined) {
              queueMicrotask(() => session?.replaceFiles({ [path]: saved }));
            }

            latest.current.reportError(toEditRefusalText(cause));
          }
        },
        signal,
        (path) => openFile(path),
        latest.current.selected,
      );

      return session;
    },
    applyCommand: (session, command) => {
      if (command.kind === "files") {
        session.replaceFiles(command.files);
        return;
      }

      if (command.reveal) {
        sendView({ type: "code.show" });
      }

      if (!command.open) {
        session.highlight(command.file, command.lines, { open: false });
        return;
      }

      // The address as it is now: a guide may have written its step since this render.
      const params = new URLSearchParams(window.location.search);

      if (Object.hasOwn(latest.current.project.manifest.files, command.file) && params.get("file") !== command.file) {
        params.set("file", command.file);
        setSearch(params, { replace: true });
      }

      session.highlight(command.file, command.lines);
    },
  });

  useEffect(() => {
    if (ready.matches("ready")) {
      ready.context.session?.select(selected);
    }
  }, [ready, selected]);

  // Edits saved while the editor prepared reached no session, so the ready editor takes the latest files. An edit typed
  // since the render wrote a newer project to `latest`, so it is never rolled back.
  useEffect(() => {
    const edited = latest.current.project;
    const newest = edited.id === project.id && edited.revision > project.revision ? edited : project;

    readySession?.replaceFiles(newest.manifest.files);
  }, [readySession, project]);

  // A layout effect, so the phone never draws the view a revealed mark leaves.
  useLayoutEffect(() => {
    if (fileOverride) {
      editorCommands.send({
        type: "command.add",
        command: { kind: "files", version: fileOverride.version, files: fileOverride.files },
      });
    }
  }, [editorCommands, fileOverride]);

  useLayoutEffect(() => {
    if (highlight) {
      editorCommands.send({
        type: "command.add",
        command: {
          kind: "highlight",
          version: highlight.version,
          file: highlight.file,
          lines: [highlight.startLine, highlight.endLine],
          open: true,
          reveal: highlight.reveal ?? false,
        },
      });
    }
  }, [editorCommands, highlight]);

  const shownResult = useControllerSelector(execution, (state) => state.result);
  const shownError = useControllerSelector(execution, (state) => state.error);

  useRunMarks({
    session: editorReady ? ready.context.session : undefined,
    result: shownResult,
    mode: runNotes,
    stepNotes,
  });

  useEffect(() => {
    if (editorReady) {
      ready.context.session?.setPhoneLayout(phone);
    }
  }, [editorReady, phone, ready.context.session]);

  useEffect(() => {
    if (editorReady) {
      ready.context.session?.setPreferredFontSize(codeFontSize);
    }
  }, [editorReady, codeFontSize, ready.context.session]);

  useEffect(() => {
    if (editorReady) {
      ready.context.session?.setReadOnly(readOnly !== undefined, readOnly ?? "");
    }
  }, [editorReady, readOnly, ready.context.session]);

  const leaveBlocker = useLeaveGuard(unsavedCopy);

  useUnloadWarning(warnOnLeave ?? shouldWarnOnUnload({ saveState, unsavedCopy }));

  const chooseFile = (path: string) => {
    editorCommands.send({ type: "file.choose" });
    openFile(path);
  };

  const diagnostic = (item: Diagnostic) => {
    const path = resolveDiagnosticFile(item.source, Object.keys(project.manifest.files));

    if (path && ready.matches("ready")) {
      chooseFile(path);
      ready.context.session?.select(path, item.line ?? 1, item.column ?? 1);

      if (phone) {
        sendView({ type: "code.show" });
      }
    }
  };

  const files = orderProjectFiles(project.manifest, seedPath);
  const errorPaths = useErrorFiles(editorReady ? ready.context.session : undefined);
  const errorFiles = new Map([...errorPaths].map((path) => [path, "TypeScript errors"]));
  const { openCreate, openRename, openDelete, helperFileDialog } = useHelperFileDialog({
    sides: 1,
    selected,
    onSubmit: ({ action, path, filename }) => {
      update(applyHelperOperation(project, action, path, filename));
      chooseFile(action === "delete" ? defaultFile : filename);
    },
  });

  const runtimeTarget = getCatalogTarget(project.manifest);
  const currentRelease = getReleaseCurrent(project.manifest);
  const switchRelease = ({ tupleId, guestFlavor }: ReleaseChoice) => {
    const tuple = listSupportedTuples(runtimeTarget).find((item) => item.id === tupleId);

    if (!tuple) {
      reportError("That Drizzle release is not available for this database.");
      return;
    }

    releaseSwitch.send({ type: "release.switch", manifest: project.manifest, tuple, guestFlavor });
  };
  const { capabilities, progress: preparationProgress } = ready.context;
  const unavailable = ready.matches("failed") || ready.matches("unsupported");
  const firstRunStatus = editorReady
    ? { state: "ready" as const }
    : unavailable
      ? { state: "unavailable" as const }
      : {
          state: "preparing" as const,
          percent: ready.matches("preparing") ? preparationPercent(preparationProgress) : null,
        };
  /**
   * Formats the files with Prettier and returns the code to run: each format edit writes `latest` at once, so the run,
   * its error lines and the code agree. A format that fails leaves the code as it is.
   */
  const formatForRun = useEffectEvent(async (signal: AbortSignal): Promise<RunCode> => {
    try {
      await ready.context.session?.formatFiles(signal);
    } catch (cause) {
      console.error("Could not format the project before its run", cause);
    }

    const { manifest, revision } = latest.current.project;

    return { manifest, revision };
  });
  const canRun =
    editorReady && !runDisabled && activeRuntime !== undefined && project.manifest.entrypoints.run !== undefined;
  const startRun = () => {
    const runtime = activeRuntime;

    if (!canRun || runtime === undefined) {
      return;
    }

    if (onRunRequest) {
      onRunRequest();
      return;
    }

    void requestRun(execution, {
      requester: "view",
      input: {
        runtime,
        submission: { manifest: project.manifest, revision: project.revision, ...runOptions.read() },
        prepare: isFormatOnRun() ? (signal) => formatForRun(signal) : undefined,
      },
    }).catch((cause) => reportError(String(cause)));
  };

  useImperativeHandle(
    control,
    () => ({
      run: async (manifest, signal) => {
        const runtime = activeRuntime;

        if (runtime === undefined || !editorReady) {
          throw new Error("The playground cannot start a run right now.");
        }

        const settled = await requestRun(execution, {
          requester: "guide",
          input: {
            runtime,
            submission: { manifest, revision: latest.current.project.revision, ...runOptions.read() },
          },
          signal,
        });

        if (settled.result === undefined) {
          throw new Error(settled.error ?? "The run stopped before it returned a result.");
        }

        return settled.result;
      },
    }),
    [activeRuntime, editorReady, execution, runOptions],
  );

  const agent = useConnectedAgent();

  useWorkspaceConnectHost({
    connect,
    runOptions,
    build: () => {
      const session = editorReady ? ready.context.session : undefined;

      return {
        project: () => latest.current.project,
        save: (next) => {
          if (!isOneVersion(next)) {
            throw new Error("This view holds a one-version project.");
          }

          save(next);
          session?.replaceFiles(next.manifest.files);
        },
        problems: () => session?.problems() ?? [],
        latestRun: () => execution.getState().result,
        running: () => execution.getState().status === "running",
        run: async () => {
          const runtime = activeRuntime;
          const current = latest.current.project;

          if (runtime === undefined || !editorReady || current.manifest.entrypoints.run === undefined) {
            throw new Error("The project cannot run right now: it is preparing. Try again in a moment.");
          }

          await requestRun(execution, {
            requester: "agent",
            input: {
              runtime,
              submission: {
                manifest: current.manifest,
                revision: current.revision,
                ...runOptions.read(),
                startedBy: agent ?? "The agent",
              },
            },
          });
        },
      };
    },
  });

  const showCapability = ready.matches("unsupported") && capabilities !== undefined;
  const { chat, chatOpen, setChatOpen, pendingPaths, workspaceChat } = useWorkspaceChat({
    connect,
    project: toChatProject(project),
    files: Object.keys(project.manifest.files),
    shown: !phone && !compact && !showCapability,
  });

  const showOutput = (tab: OutputTab) => {
    setOutputTab(tab);

    if (phone) {
      sendView({ type: "output.show" });
    }
  };
  const runButtonState: RunButtonState = running ? "running" : editorReady || unavailable ? "ready" : "preparing";
  const asideContent = aside?.renderContent({ phone, runState: runButtonState, canRun, run: startRun, showOutput });
  const shownCounts = countTimeline(buildRunTimeline(shownResult, shownError || undefined));
  const outputBadge: PhoneOutputBadge | undefined =
    shownResult === undefined && shownError === ""
      ? undefined
      : shownResult?.outcome === "succeeded"
        ? { outcome: "succeeded", count: shownCounts.results }
        : { outcome: "failed", count: shownCounts.problems };
  const fileRoles = getFileRoles({
    entrypoints: project.manifest.entrypoints,
    seedPath,
    selected,
    hasFile: (path) => Object.hasOwn(project.manifest.files, path),
  });

  return {
    mode,
    phone,
    compact,
    view,
    attachHost,
    files,
    selected,
    chooseFile,
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
    execution,
    runOptions,
    runButtonState,
    canRun,
    startRun,
    cancelRun: () => {
      void execution.cancel().catch((cause) => reportError(getErrorText(cause)));
    },
    editorReady,
    unavailable,
    preparationFailed: ready.matches("failed"),
    preparationError: ready.context.error,
    retryPreparation: () => readiness.send({ type: "readiness.retry" }),
    codeFontSize,
    /** The capability check's report while this browser cannot run the project; undefined otherwise. */
    unsupportedCapabilities: showCapability ? capabilities : undefined,
    diagnostic,
    outputTab,
    setOutputTab,
    firstRunStatus,
    outputBadge,
    chat,
    chatOpen,
    setChatOpen,
    workspaceChat,
    asideContent,
    release: {
      open: releaseOpen,
      setOpen: setReleaseOpen,
      target: runtimeTarget,
      current: currentRelease,
      files: project.manifest.files,
      switchRelease,
      switching: switchingRelease,
    },
  };
}
