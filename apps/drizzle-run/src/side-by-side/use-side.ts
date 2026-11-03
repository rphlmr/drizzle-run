import type { Executor, QueryPlansSettings } from "@drizzle-run/core/contracts";
import type { RunManifest } from "@drizzle-run/core/manifest";
import type { PairSideIndex } from "@drizzle-run/core/pair";
import { type PairSideRun } from "@drizzle-run/orchestration";
import { useRunController } from "@drizzle-run/react";
import type { createBrowserRuntime } from "@drizzle-run/runtime/browser";
import { useEffect, useEffectEvent, useRef } from "react";

import { getErrorText } from "../lib/error-text";
import { requestRun, RunStoppedError } from "../project/run-request";
import { getSharedRuntime, holdSharedRuntime } from "../project/shared-runtime";
import { useEditorController } from "../workspace/use-editor-controller";

type BrowserRuntime = ReturnType<typeof createBrowserRuntime>;

/** What a side's run captures besides its output, as a one-version run's submission sets it. */
export interface SideRunOptions {
  debug?: boolean;
  queryPlans?: QueryPlansSettings;
  /** A comparison's execution port; the SDK coordinator owns starting and cancelling its child. */
  runtime?: Executor;
}

/** Options of `useSide`: the side, what it runs, and where its edits go. */
export interface UseSideOptions {
  side: PairSideIndex;
  projectId: string;
  /** What this side runs now: the shared files plus its own, on its own pair. */
  manifest: RunManifest;
  /** The side's files and the open file as they are when the editor prepares. */
  current: () => { manifest: RunManifest; selected: string };
  onEdit: (side: PairSideIndex, path: string, content: string) => void;
  onNavigate: (path: string) => void;
  /** A runtime the page already owns, such as the embed's; the side's shared page runtime otherwise. */
  runtime?: BrowserRuntime;
  /** Called with the file a mark opens on this side, such as a guide step's. */
  onMarkFile?: (side: PairSideIndex, path: string) => void;
}

/**
 * One side of a side-by-side project: its own page runtime, its own editor checked against its
 * own release, and its own run machine. Each run still starts a fresh guest and database.
 */
export function useSide({
  side,
  projectId,
  manifest,
  current,
  onEdit,
  onNavigate,
  runtime: suppliedRuntime,
  onMarkFile,
}: UseSideOptions) {
  const runtime = useRef<BrowserRuntime | undefined>(undefined);
  const readCurrent = useEffectEvent(() => current());
  const execution = useRunController();
  // The database is part of it: a side moved to the other database on the same release needs its types and runtime.
  const environmentKey = JSON.stringify([
    projectId,
    side,
    manifest.target.dialect,
    manifest.dependencies,
    manifest.guestFlavor,
    Object.keys(manifest.files),
  ]);
  const { attachHost, readiness, ready, editorReady, session, editorCommands } = useEditorController({
    environmentKey,
    runtime: suppliedRuntime,
    preparation: "on_demand",
    getSharedRuntime: () => getSharedRuntime(side),
    readManifest: () => current().manifest,
    onRuntime: (sideRuntime) => {
      runtime.current = sideRuntime;
    },
    openEditor: (environment, signal, element) => {
      const { manifest: sideManifest, selected } = current();

      // Both editors share one TypeScript program: only the first side declares the `$` helpers.
      return environment.prepareEditor(
        element,
        sideManifest,
        (path, content) => onEdit(side, path, content),
        signal,
        (path) => onNavigate(path),
        selected,
        { isolation: { globals: side === 0 } },
      );
    },
    applyCommand: (sideSession, command) => {
      if (command.kind === "files") {
        sideSession.replaceFiles(command.files);
        return;
      }

      sideSession.highlight(command.file, command.lines, { open: command.open });

      if (command.open) {
        onMarkFile?.(side, command.file);
      }
    },
  });

  useEffect(() => (suppliedRuntime === undefined ? holdSharedRuntime(side) : undefined), [side, suppliedRuntime]);

  // Edits saved while the editor prepared, such as the other side's to a shared file, reached no session, so the ready
  // editor takes the latest files once.
  useEffect(() => {
    session?.replaceFiles(readCurrent().manifest.files);
  }, [session]);

  /**
   * Runs `submitted` (this side's files by default) and resolves when the run settles. Aborting
   * `signal` cancels it; a side that cannot run now, or is already running, settles as failed, and a view closed
   * mid-run as cancelled. `options` sets Debug traces and Query plans, off by default.
   */
  const run = async (
    submitted: RunManifest,
    revision: number,
    signal: AbortSignal,
    options: SideRunOptions = {},
  ): Promise<PairSideRun> => {
    const sideRuntime = options.runtime ?? runtime.current;

    if (signal.aborted) {
      return { outcome: "cancelled" };
    }

    if (sideRuntime === undefined || !editorReady) {
      return { outcome: "failed", error: "This side cannot start a run right now." };
    }

    try {
      const { outcome, result, error } = await requestRun(execution, {
        requester: "pair",
        input: {
          runtime: sideRuntime,
          submission: {
            manifest: submitted,
            revision,
            debug: options.debug ?? false,
            ...(options.queryPlans === undefined ? {} : { queryPlans: options.queryPlans }),
          },
        },
        signal,
      });

      return { outcome, ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) };
    } catch (cause) {
      return cause instanceof RunStoppedError
        ? { outcome: "cancelled" }
        : { outcome: "failed", error: getErrorText(cause) };
    }
  };

  return { side, attachHost, readiness, ready, execution, editorCommands, editorReady, session, run };
}

/** One side of a side-by-side playground: its editor, readiness and run. */
export type SidePlayground = ReturnType<typeof useSide>;
