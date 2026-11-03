import { useSyncExternalStore } from "react";

/** The same viewports as Tailwind's `max-phone:` variant (theme.css `--breakpoint-phone`). */
export const PHONE_QUERY = "(width < 780px)";

/** Whether the media query matches, updated as it changes. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);

      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
