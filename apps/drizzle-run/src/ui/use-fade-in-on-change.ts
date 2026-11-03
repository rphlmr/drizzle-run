import { useLayoutEffect, useRef } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const FALLBACK_DURATION_MS = 120;

function readTimeMs(value: string) {
  const amount = Number.parseFloat(value);

  if (!Number.isFinite(amount)) {
    return FALLBACK_DURATION_MS;
  }

  return value.trim().endsWith("ms") ? amount : amount * 1000;
}

/**
 * Fade in on change
 *
 * Fades the element given `ref` in, rising 4 px, each time `changeKey` changes after the first render, such as when a
 * new run's output replaces the last one. The element stays mounted, so its scroll and inner state survive. A Web
 * Animation, which the reduced motion rule in theme.css cannot reach, so it checks the preference itself. It runs
 * before paint, so the new content never shows a frame at full opacity first.
 */
export function useFadeInOnChange<TElement extends HTMLElement>(changeKey: string | number | undefined) {
  const ref = useRef<TElement | null>(null);
  const previousKey = useRef(changeKey);

  useLayoutEffect(() => {
    if (previousKey.current === changeKey) {
      return;
    }

    previousKey.current = changeKey;
    const element = ref.current;

    if (!element || matchMedia(REDUCED_MOTION_QUERY).matches) {
      return;
    }

    const tokens = getComputedStyle(element);
    element.animate(
      [
        { opacity: 0, translate: "0 4px" },
        { opacity: 1, translate: "0 0" },
      ],
      {
        duration: readTimeMs(tokens.getPropertyValue("--motion-fast")),
        easing: tokens.getPropertyValue("--motion-ease").trim() || "ease-out",
      },
    );
  }, [changeKey]);

  return ref;
}
