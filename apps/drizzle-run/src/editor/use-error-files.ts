import { useMemo, useSyncExternalStore } from "react";

import type { prepareEditor } from "./environment";

type EditorSession = Pick<Awaited<ReturnType<typeof prepareEditor>>, "onProblemsChange" | "problems">;

const NO_FILES = "";

/**
 * A store of the files with an error, sorted and joined into one string
 *
 * React reads the snapshot on every render, such as each keystroke's, so it is worked out again only after the marks
 * change. A string stays equal while the same files have errors, so an unrelated mark change renders nothing.
 */
function createErrorFilesStore(session: EditorSession | undefined) {
  let cached: string | undefined;
  const readErrorFiles = () =>
    session === undefined
      ? NO_FILES
      : [
          ...new Set(
            session
              .problems()
              .filter((problem) => problem.severity === "error")
              .map((problem) => problem.path),
          ),
        ]
          .toSorted()
          .join("\n");

  return {
    // Marks may have changed before React subscribed, so subscribing reads them again.
    subscribe: (onChange: () => void) => {
      cached = undefined;

      return (
        session?.onProblemsChange(() => {
          cached = undefined;
          onChange();
        }) ?? (() => {})
      );
    },
    getSnapshot: () => (cached ??= readErrorFiles()),
  };
}

/**
 * The files TypeScript marks with an error in an editor session, kept current as its marks change
 *
 * Empty while the session is not ready. Warnings leave a file unmarked.
 */
export function useErrorFiles(session: EditorSession | undefined): ReadonlySet<string> {
  const store = useMemo(() => createErrorFilesStore(session), [session]);
  const files = useSyncExternalStore(store.subscribe, store.getSnapshot);

  return useMemo(() => new Set(files === NO_FILES ? [] : files.split("\n")), [files]);
}
