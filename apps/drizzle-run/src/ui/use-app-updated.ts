import { useEffect, useState } from "react";

/**
 * Whether a part of the app failed to load
 *
 * Vite fires `vite:preloadError` when a lazy chunk does not load, as in a tab opened before a deploy replaced the
 * app's files. The tab's code still names the old files, so only a reload brings it back.
 */
export function useAppUpdated(): boolean {
  const [updated, setUpdated] = useState(false);

  useEffect(() => {
    const markUpdated = () => setUpdated(true);

    window.addEventListener("vite:preloadError", markUpdated);

    return () => window.removeEventListener("vite:preloadError", markUpdated);
  }, []);

  return updated;
}
