import type { CSSProperties } from "react";

import { EDITOR_TEXT, resolveEditorText, type EditorFontSize } from "../design/editor-font-size";
import { cn } from "../lib/utils";

/**
 * The selected file as plain text, set like the editor (font, size and line height, 12/20 px on phones, top
 * padding), so code shows from the first frame and the editor takes its place unnoticed. `fontSize` is the size the
 * viewer picked, with each layout's line height kept in proportion.
 */
/** The editor text sizes as custom properties, which React's `CSSProperties` does not list */
type CodeTextProperties = CSSProperties &
  Record<"--code-font-size" | "--code-line-height" | "--code-line-height-phone", string>;

export function CodePreview({ code, fontSize = null }: { code: string; fontSize?: EditorFontSize | null }) {
  const lines = code.split("\n");
  const pickedText: CodeTextProperties | undefined =
    fontSize === null
      ? undefined
      : {
          "--code-font-size": `${fontSize}px`,
          "--code-line-height": `${resolveEditorText(EDITOR_TEXT.desktop, fontSize).lineHeight}px`,
          "--code-line-height-phone": `${resolveEditorText(EDITOR_TEXT.phone, fontSize).lineHeight}px`,
        };

  return (
    <pre
      className={cn(
        "min-h-0 flex-1 overflow-auto pt-6 font-mono whitespace-pre text-text",
        pickedText === undefined
          ? "text-[12px]/5.5 max-phone:leading-5"
          : "text-(length:--code-font-size) leading-(--code-line-height) max-phone:leading-(--code-line-height-phone)",
      )}
      style={pickedText}
      aria-label="Code, read only while the editor loads"
      data-slot="code-preview"
    >
      <code>
        {lines.map((line, index) => (
          <span key={index} className="flex">
            {/* Monaco's gutter: five digit widths, rounded, then the 26 px decorations lane (folding included). */}
            <span
              className="w-[calc(round(5ch,1px)+26px)] shrink-0 pr-6.5 text-right text-faint select-none"
              aria-hidden="true"
            >
              {index + 1}
            </span>
            <span data-line="">{line}</span>
          </span>
        ))}
      </code>
    </pre>
  );
}
