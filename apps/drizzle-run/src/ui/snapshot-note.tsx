import type { ReactNode } from "react";

/**
 * The hint under the header of an example or a shared snapshot: quiet text on a white panel like the editor and
 * output ones, so it never reads as an alert nor as text laid on the gray frame.
 */
export function SnapshotNote({ children }: { children: ReactNode }) {
  return (
    <div
      className="mx-3 mt-1 flex flex-none flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border border-border bg-surface px-4 py-2.5 text-[13px] text-muted shadow-sticker max-phone:m-0 max-phone:items-start max-phone:rounded-none max-phone:border-x-0 max-phone:border-t-0 max-phone:px-3 max-phone:py-2 max-phone:shadow-none **:[[role=alert]]:text-err [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-accent-text max-phone:[&>svg]:mt-0.5 max-phone:[&>svg+span]:min-w-0 max-phone:[&>svg+span]:flex-1"
      role="note"
    >
      {children}
    </div>
  );
}
