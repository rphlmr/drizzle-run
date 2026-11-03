import type { ReactNode } from "react";

/**
 * The hint line under the header of an example or a shared snapshot: quiet text, no fill, so it never reads as an
 * alert.
 */
export function SnapshotNote({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex flex-none flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border px-4 py-2 text-[13px] text-muted max-phone:items-start max-phone:px-3 **:[[role=alert]]:text-err [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-accent-text max-phone:[&>svg]:mt-0.5 max-phone:[&>svg+span]:min-w-0 max-phone:[&>svg+span]:flex-1"
      role="note"
    >
      {children}
    </div>
  );
}
