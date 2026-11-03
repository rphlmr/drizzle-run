import { useEffect } from "react";
import { useBlocker, type Blocker } from "react-router";

let leavingOnPurpose = false;

/**
 * Hold an in-app navigation that would drop unsaved edits
 *
 * While `active`, a link, a redirect or Back that leaves the page's path is blocked until the returned blocker proceeds
 * or resets; render `LeaveDialog` with it. Search and hash changes on the same path pass. The router holds one blocker
 * at a time, so only one page on screen may call it.
 */
export function useLeaveGuard(active: boolean): Blocker {
  return useBlocker(
    ({ currentLocation, nextLocation }) =>
      active && !leavingOnPurpose && currentLocation.pathname !== nextLocation.pathname,
  );
}

/** Ask before the browser unloads the page while `active`, as `useLeaveGuard` asks before an in-app navigation. */
export function useUnloadWarning(active: boolean) {
  useEffect(() => {
    if (!active) {
      return;
    }

    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };

    window.addEventListener("beforeunload", handler);

    return () => window.removeEventListener("beforeunload", handler);
  }, [active]);
}

/**
 * Navigate without asking
 *
 * For a navigation that keeps the edits, such as opening the project a Fork just saved. `navigate` must start the
 * navigation before it returns, as React Router's `navigate` does: the router asks its blocker synchronously.
 */
export function leaveOnPurpose(navigate: () => void) {
  leavingOnPurpose = true;

  try {
    navigate();
  } finally {
    leavingOnPurpose = false;
  }
}
