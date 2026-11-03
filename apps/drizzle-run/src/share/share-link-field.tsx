import { useId, type ReactNode } from "react";

import { cn } from "../lib/utils";

/** A one-line share URL, selected whole on focus so it can still be copied by hand. */
export function ShareLinkField({
  label,
  url,
  children,
  labelClassName,
}: {
  label: string;
  url: string;
  children?: ReactNode;
  labelClassName?: string;
}) {
  const id = useId();

  return (
    <div className="flex max-w-full min-w-0 flex-col gap-2">
      <label htmlFor={id} className={cn("text-[14px] font-medium text-text", labelClassName)}>
        {label}
      </label>
      <div className={cn("grid min-w-0 grid-cols-1 gap-2", children && "sm:grid-cols-[minmax(0,1fr)_auto]")}>
        <input
          id={id}
          readOnly
          spellCheck={false}
          value={url}
          onFocus={(event) => event.currentTarget.select()}
          className="h-9 w-full max-w-full min-w-0 truncate rounded-base border border-border bg-surface px-3 font-mono text-[13px] text-text selection:bg-lime/35 selection:text-text focus-visible:border-ring"
        />
        {children}
      </div>
    </div>
  );
}
