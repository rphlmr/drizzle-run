import { CheckIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/utils";

export interface ToastProps {
  children: ReactNode;
  /** A link or button after the message. */
  action?: ReactNode;
  tone?: "success" | "error";
  onDismiss: () => void;
}

/** A status toast centered over the status bar, full width with 12 px margins on a phone. */
export function Toast({ children, action, onDismiss, tone = "success" }: ToastProps) {
  return (
    <output
      className="fixed bottom-10.5 left-1/2 z-40 flex w-max max-w-[min(520px,calc(100vw-32px))] -translate-x-1/2 items-center gap-2.5 rounded-[12px] border-[1.5px] border-card-border bg-surface py-2 pr-2 pl-2.5 text-[13px] text-text shadow-sticker-card max-phone:inset-x-3 max-phone:bottom-4 max-phone:w-auto max-phone:max-w-none max-phone:translate-x-0"
      data-slot="toast"
      role={tone === "error" ? "alert" : "status"}
    >
      <span
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-[7px]",
          tone === "error" ? "bg-err-bg text-err" : "bg-ok-bg text-ok",
        )}
        aria-hidden="true"
      >
        {tone === "error" ? (
          <TriangleAlertIcon className="size-3.5 stroke-[2.4]" />
        ) : (
          <CheckIcon className="size-3.5 stroke-[2.4]" />
        )}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
      {action}
      <button
        type="button"
        className="relative grid size-7 shrink-0 place-items-center rounded-[7px] border-0 bg-transparent text-muted after:absolute after:-inset-2 hover:bg-surface-2 hover:text-text"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <XIcon className="size-4" aria-hidden="true" />
      </button>
    </output>
  );
}
