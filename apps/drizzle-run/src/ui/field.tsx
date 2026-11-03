import type { ReactNode } from "react";

import { cn } from "../lib/utils";

/** A labelled form row: the label text, then its control, then notes. */
export const fieldClass = cn("flex flex-col gap-2 font-medium");

/** The text input inside a field, taller and with the ink border. */
export const fieldInputClass = cn("m-0 h-10.5 rounded-md border-[1.5px] border-card-border font-normal");

/** A muted hint under a form field; a `live` one announces its text as it changes. */
export function FieldNote({ live = false, children }: { live?: boolean; children: ReactNode }) {
  return <p className="text-[12px] font-normal text-muted">{live ? <output>{children}</output> : children}</p>;
}

/** A form field's error, announced as an alert. */
export function FieldError({ children }: { children: ReactNode }) {
  // Important: empty states and the embed message mute every paragraph inside them.
  return (
    <p className="text-[13px] text-err!" role="alert">
      {children}
    </p>
  );
}

/** Two choices side by side. */
export const choiceGridClass = cn("grid grid-cols-2 gap-2.5");

/** A radio card; the checked one boldens. */
export function ChoiceCard({
  checked,
  className,
  children,
}: {
  checked: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex min-h-touch cursor-pointer items-center gap-2.5 rounded-[12px] border border-border bg-surface p-3 font-medium",
        checked && "border-[1.5px] border-card-border font-semibold",
        className,
      )}
    >
      {children}
    </label>
  );
}
