import type { ReactNode } from "react";

import { cn } from "../lib/utils";

/**
 * A centered page body for loading, empty, and error states. Its paragraph rule also
 * reaches paragraphs of nested panels, such as the release panel's notes.
 */
export function EmptyState({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <main
      className={cn(
        "relative flex min-h-75 flex-1 flex-col items-center justify-center gap-5 p-6 text-center",
        "[&>h1]:m-0 [&>h1]:font-display [&>h1]:text-[28px] [&>h1]:font-extrabold [&>h1]:tracking-[-0.02em]",
        "[&_p]:m-0 [&_p]:max-w-90 [&_p]:leading-[1.6] [&_p]:text-muted",
        className,
      )}
    >
      {children}
    </main>
  );
}
