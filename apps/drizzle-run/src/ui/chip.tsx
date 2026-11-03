import type { ReactNode } from "react";

import { cn } from "../lib/utils";

/** A pill-shaped toggle, such as a topic filter. */
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
        "h-8.5 rounded-full border px-3.5 font-medium whitespace-nowrap disabled:opacity-50 max-phone:min-h-touch",
        pressed ? "border-segment bg-segment text-segment-fg" : "border-border bg-surface text-text",
      )}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
