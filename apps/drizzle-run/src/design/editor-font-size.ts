/** A size and line height, in px, that code is set at. */
export interface EditorText {
  fontSize: number;
  lineHeight: number;
}

/** The code sizes the viewer can pick, in px. */
export const EDITOR_FONT_SIZES = [14, 16] as const;

/** A code size the viewer picked; `null` keeps each layout's own size. */
export type EditorFontSize = (typeof EDITOR_FONT_SIZES)[number];

/** Default editor font size and line height in pixels. */
export const EDITOR_TEXT = {
  desktop: { fontSize: 12, lineHeight: 22 },
  phone: { fontSize: 12, lineHeight: 20 },
} as const satisfies Record<string, EditorText>;

const STORAGE_KEY = "editor-font-size";
const CHANGE_EVENT = "drizzle-run:editor-font-size";

/**
 * Read the stored code size
 *
 * A missing or unknown value, or a throwing storage, means `null`: each layout keeps its own size.
 */
export function readEditorFontSize(storage: Pick<Storage, "getItem"> | null): EditorFontSize | null {
  try {
    const value = storage?.getItem(STORAGE_KEY);

    return EDITOR_FONT_SIZES.find((size) => String(size) === value) ?? null;
  } catch {
    return null;
  }
}

/**
 * Save a code size
 *
 * `null` removes the stored size, so the default follows later changes to the layouts' sizes.
 */
export function writeEditorFontSize(
  storage: Pick<Storage, "setItem" | "removeItem"> | null,
  size: EditorFontSize | null,
): void {
  try {
    if (size === null) {
      storage?.removeItem(STORAGE_KEY);
    } else {
      storage?.setItem(STORAGE_KEY, String(size));
    }
  } catch {
    // Storage can be full or blocked; the size still applies for this page.
  }
}

/**
 * Set code at a picked size
 *
 * Keeps a layout's line height in proportion to its size, rounded to whole pixels so the gutter and the code stay on
 * the same rows. `null` returns the layout's own text.
 *
 * @example
 * resolveEditorText({ fontSize: 12, lineHeight: 22 }, 14); // { fontSize: 14, lineHeight: 26 }
 */
export function resolveEditorText(layout: EditorText, size: EditorFontSize | null): EditorText {
  if (size === null) {
    return layout;
  }

  return { fontSize: size, lineHeight: Math.round((size * layout.lineHeight) / layout.fontSize) };
}

function getSafeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Reads the stored code size; private windows that block storage read as `null`. */
export function readCurrentEditorFontSize(): EditorFontSize | null {
  return readEditorFontSize(getSafeStorage());
}

/** Saves the code size and tells every editor on the page to apply it. */
export function applyEditorFontSize(size: EditorFontSize | null): void {
  writeEditorFontSize(getSafeStorage(), size);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * Watch the code size
 *
 * Calls `onChange` when this page or another tab saves a size. Returns the function that stops watching.
 */
export function subscribeEditorFontSize(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    // A null key is a `clear()`, which removes the size too.
    if (event.key === STORAGE_KEY || event.key === null) {
      onChange();
    }
  };

  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);

  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
