import { useEffect, useState } from "react";

/**
 * The code's lines as Monaco colors them, once Monaco has loaded; undefined until then
 *
 * Monaco loads lazily, so a view that never opens an editor, such as a recorded embed, still shows plain text from the
 * first frame and gains its colors after. The colors follow the theme: a theme change colors the code again.
 */
export function useColorizedLines(code: string): string[] | undefined {
  const [colored, setColored] = useState<{ code: string; lines: string[] }>();

  useEffect(() => {
    let current = true;
    let request = 0;

    const color = () => {
      const latest = ++request;
      void import("./environment")
        .then((editor) => editor.colorizeCode(code, "typescript"))
        .then((html) => {
          if (current && request === latest) {
            setColored({ code, lines: splitColorizedLines(html) });
          }
        })
        .catch(() => undefined);
    };

    const observer = new MutationObserver(color);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    color();

    return () => {
      current = false;
      observer.disconnect();
    };
  }, [code]);

  return colored?.code === code ? colored.lines : undefined;
}

/** Monaco's colorized HTML holds one line per `<br/>`, inside an optional wrapper element. */
export function splitColorizedLines(html: string): string[] {
  const inner = html.replace(/^<div[^>]*>/, "").replace(/<\/div>\s*$/, "");

  return inner.split(/<br\s*\/?>/);
}
