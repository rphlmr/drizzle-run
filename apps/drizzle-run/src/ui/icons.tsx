import { cn } from "../lib/utils";

/** Two panes next to each other: the side-by-side badge, and a file with a copy per side. */
export function SidesIcon({ className, label }: { className?: string; label?: string }) {
  return (
    <svg
      className={cn("size-3.25 shrink-0", className)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
    >
      <rect x="3" y="4" width="7.5" height="16" rx="1.5" />
      <rect x="13.5" y="4" width="7.5" height="16" rx="1.5" />
    </svg>
  );
}
