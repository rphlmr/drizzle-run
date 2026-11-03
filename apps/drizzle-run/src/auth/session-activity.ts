/** Activity checks are independent of the server's daily renewal threshold. */
export const sessionActivityIntervalMs = 60 * 60 * 1000;

/** Recheck a visible, active page at most hourly; an idle or hidden tab does not keep a session alive. */
export function followSessionActivity({
  page,
  nowMs,
  refresh,
}: {
  page: { window: EventTarget; document: EventTarget & Pick<Document, "visibilityState"> };
  nowMs: () => number;
  refresh: () => void;
}): () => void {
  let checkedAtMs = nowMs();
  const check = () => {
    const now = nowMs();

    if (page.document.visibilityState !== "visible" || now - checkedAtMs < sessionActivityIntervalMs) {
      return;
    }

    checkedAtMs = now;
    refresh();
  };

  page.window.addEventListener("focus", check);
  page.document.addEventListener("visibilitychange", check);
  page.document.addEventListener("pointerdown", check);
  page.document.addEventListener("keydown", check);

  return () => {
    page.window.removeEventListener("focus", check);
    page.document.removeEventListener("visibilitychange", check);
    page.document.removeEventListener("pointerdown", check);
    page.document.removeEventListener("keydown", check);
  };
}
