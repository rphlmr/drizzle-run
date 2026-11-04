import type { ReactNode } from "react";

import { cn } from "../lib/utils";

/** A compact toggle, such as a topic filter. */
export function Chip({
  pressed,
  disabled,
  onClick,
  children,
}: {
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        "h-8 rounded-md border border-transparent px-2.5 text-[12px] font-medium whitespace-nowrap transition-colors disabled:opacity-50 max-phone:min-h-touch",
        pressed ? "bg-surface-2 text-text" : "bg-transparent text-muted hover:bg-surface-2 hover:text-text",
      )}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
