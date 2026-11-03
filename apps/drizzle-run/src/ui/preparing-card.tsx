import { useEffect, useId, useRef } from "react";

import { Button } from "../components/ui/button";

type PreparationFailedDialogProps = {
  /** Why preparation stopped, as the readiness machine words it. */
  error: string | undefined;
  /** The muted line beside the action, such as "Your files stay as they are." */
  note: string;
  onRetry: () => void;
};

/**
 * Preparation failed dialog
 *
 * Centered on the screen when a runtime could not prepare. Nothing runs until it does, so it has no close, and
 * "Try again" starts preparing again, which unmounts it. It is not modal: the header stays usable, so the person can
 * switch project, export, pick another release or leave. A side-by-side view shows one for both sides.
 */
export function PreparationFailedDialog({ error, note, onRetry }: PreparationFailedDialogProps) {
  const card = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    card.current?.focus();
  }, []);

  return (
    <div
      ref={card}
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      className="fixed top-1/2 left-1/2 z-50 w-full max-w-100 -translate-1/2 rounded-lg border-[1.5px] border-card-border bg-bg p-6.5 text-text shadow-sticker-lg focus-visible:outline-transparent max-phone:w-[calc(100vw-28px)]"
    >
      <h2 id={titleId} className="font-display text-[24px] font-extrabold tracking-[-0.02em]">
        Preparation didn't finish
      </h2>
      <p id={descriptionId} className="mt-2 mb-5 text-[14px] leading-[1.6] text-muted">
        {error ?? "The runtime stopped before it was ready."}
      </p>
      <div className="mt-6 flex flex-col-reverse items-center justify-between gap-1.75 sm:flex-row">
        <p className="text-[12px] leading-[1.6] text-muted">{note}</p>
        <Button variant="sticker" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  );
}
