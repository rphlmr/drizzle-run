import { useSearchParams } from "react-router";

import type { ProjectPreferenceStorage } from "../store/storage";

/** Options of `useRememberedFile`. */
export interface UseRememberedFileOptions {
  projectId: string;
  storage: Pick<ProjectPreferenceStorage, "preference">;
  /** The file shown when neither the URL nor the remembered file names one the project has. */
  defaultFile: string;
  /** The file this project last showed, as the page's loader read it. */
  rememberedFile: string | undefined;
  /** Whether the project has `path`. */
  hasFile: (path: string) => boolean;
  reportError: (message: string) => void;
}

/**
 * The open file of a workspace view
 *
 * The URL's `file` names it. Without one, the file this project last showed opens, if it still exists. Choosing a
 * file writes both the URL and the remembered file.
 */
export function useRememberedFile({
  projectId,
  storage,
  defaultFile,
  rememberedFile,
  hasFile,
  reportError,
}: UseRememberedFileOptions) {
  const [search, setSearch] = useSearchParams();
  const requested = search.get("file") ?? rememberedFile;
  const selected = requested !== undefined && hasFile(requested) ? requested : defaultFile;

  const chooseFile = (path: string) => {
    setSearch((params) => {
      params.set("file", path);
      return params;
    });
    void storage
      .preference(projectId, path)
      .catch((cause) => reportError(`File preference could not save: ${String(cause)}`));
  };

  return { selected, chooseFile };
}
