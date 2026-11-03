import { useSyncExternalStore } from "react";

import { readCurrentEditorFontSize, subscribeEditorFontSize, type EditorFontSize } from "../design/editor-font-size";

/** The code size the viewer picked, or `null` for each layout's own size, updated as it changes. */
export function useEditorFontSize(): EditorFontSize | null {
  return useSyncExternalStore(subscribeEditorFontSize, readCurrentEditorFontSize, () => null);
}
