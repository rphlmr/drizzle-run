import { useLayoutEffect, useState, type CSSProperties } from "react";

import { cn } from "../lib/utils";

/** Positions the indicator; the track is `relative` and each option `relative`, so options paint above it. */
export const selectionIndicatorClass = cn(
  "pointer-events-none absolute transition-[left,width] duration-(--motion-fast) ease-out",
);

/**
 * Selection indicator
 *
 * The box of the track's selected option (the child whose `data-option` is `selectedKey`), for one fill that slides
 * between options the way Base UI's Tabs.Indicator does. Measured before paint, so the fill never flashes away, and
 * again whenever the track resizes. `undefined` while no option matches.
 *
 * @param selectedKey - The selected option's `data-option` value.
 */
export function useSelectionIndicator(selectedKey: string): {
  trackRef: (track: HTMLElement | null) => void;
  indicatorStyle: CSSProperties | undefined;
} {
  const [track, setTrack] = useState<HTMLElement | null>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<CSSProperties>();

  useLayoutEffect(() => {
    if (!track) {
      return undefined;
    }

    const measure = () => {
      const selected = track.querySelector<HTMLElement>(`[data-option="${CSS.escape(selectedKey)}"]`);

      if (!selected) {
        setIndicatorStyle(undefined);
        return;
      }

      // Rectangles, not offsets: options that share the width have fractional boxes.
      const trackBox = track.getBoundingClientRect();
      const selectedBox = selected.getBoundingClientRect();
      setIndicatorStyle({
        left: selectedBox.left - trackBox.left - track.clientLeft,
        top: selectedBox.top - trackBox.top - track.clientTop,
        width: selectedBox.width,
        height: selectedBox.height,
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);

    return () => observer.disconnect();
  }, [track, selectedKey]);

  return { trackRef: setTrack, indicatorStyle };
}
