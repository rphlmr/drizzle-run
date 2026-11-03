import { useEffect, useState } from "react";

/** An element's content box in pixels. */
export type ElementSizePx = {
  widthPx: number;
  heightPx: number;
};

/**
 * Element size
 *
 * The content size in pixels of the element given `ref`, kept current as it resizes; `null` until it
 * mounts and is measured. A callback ref, so an element that mounts after the first render is still observed.
 */
export function useElementSizePx(): { ref: (element: HTMLElement | null) => void; sizePx: ElementSizePx | null } {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [sizePx, setSizePx] = useState<ElementSizePx | null>(null);

  useEffect(() => {
    if (!element) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setSizePx({ widthPx: entry.contentRect.width, heightPx: entry.contentRect.height });
      }
    });
    observer.observe(element);

    return () => observer.disconnect();
  }, [element]);

  return { ref: setElement, sizePx };
}
