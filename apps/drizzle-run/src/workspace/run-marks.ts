import type { RunResult } from "@drizzle-run/core/contracts";
import { useEffect, useMemo } from "react";

import type { prepareEditor } from "../editor/environment";
import { getRunProblems } from "../ui/output-tab";
import { getRunNotes, type RunNote } from "../ui/run-notes";
import { useRunNotesShown } from "./run-notes-setting";

type EditorSession = Awaited<ReturnType<typeof prepareEditor>>;

/**
 * Which notes the shown run leaves in the code: the playground's, a guide's (commit chips say the writes kept), or
 * none, such as for a guide's earlier step or an embed.
 */
export type RunNotesMode = "playground" | "guided" | "off";

/** Where the shown run failed in the code, for the editor's error mark. */
export interface RunErrorMark {
  path: string;
  line: number;
  message: string;
}

/** The shown run's error mark, or undefined when it did not fail at a known line. */
export function getRunErrorMark(
  result: Pick<RunResult, "diagnostics" | "error"> | undefined,
): RunErrorMark | undefined {
  const failedAt = getRunProblems(result).errorLocation;

  if (failedAt?.source === undefined || failedAt.line === undefined) {
    return undefined;
  }

  return { path: failedAt.source, line: failedAt.line, message: failedAt.message };
}

/** The notes the editor shows: the shown run's in `mode`, then the guide step's own. */
export function getEditorRunNotes(
  result: Pick<RunResult, "transactions"> | undefined,
  mode: RunNotesMode,
  stepNotes: readonly RunNote[] = [],
): RunNote[] {
  const runNotes = result !== undefined && mode !== "off" ? getRunNotes(result, { guided: mode === "guided" }) : [];

  return [...runNotes, ...stepNotes];
}

/** Options of `useRunMarks`. */
export interface UseRunMarksOptions {
  /** The editor, once it is ready for the project; nothing is marked before. */
  session: Pick<EditorSession, "markError" | "setRunNotes"> | undefined;
  /** The run the output shows. */
  result: RunResult | undefined;
  mode: RunNotesMode;
  stepNotes?: readonly RunNote[];
}

/**
 * The shown run's marks in one editor
 *
 * Marks the line the run failed at and leaves the run's notes in the code, again each time the shown run, the mode
 * or the editor changes. The viewer can turn the run's notes off from the More menu; the error mark and the guide
 * step's notes stay. A side-by-side project calls it once per side.
 */
export function useRunMarks({ session, result, mode, stepNotes }: UseRunMarksOptions) {
  const errorMark = getRunErrorMark(result);
  const errorPath = errorMark?.path;
  const errorLine = errorMark?.line;
  const errorMessage = errorMark?.message;
  const runNotesShown = useRunNotesShown();
  const shownMode = runNotesShown ? mode : "off";
  const notes = useMemo(() => getEditorRunNotes(result, shownMode, stepNotes), [result, shownMode, stepNotes]);

  useEffect(() => {
    session?.markError(
      errorPath !== undefined && errorLine !== undefined && errorMessage !== undefined
        ? { path: errorPath, line: errorLine, message: errorMessage }
        : undefined,
    );
  }, [session, errorPath, errorLine, errorMessage]);

  useEffect(() => {
    session?.setRunNotes(notes);
  }, [session, notes]);
}
