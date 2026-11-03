"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "../../lib/utils";

function Switch({
  className,
  size = "default",
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: "sm" | "default";
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex h-4.75 w-8 items-center rounded-full bg-border p-0.5 transition-all after:absolute after:-inset-x-3 after:-inset-y-2 data-checked:bg-segment data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-3.75 rounded-full bg-surface shadow-[0_0_0_1px_var(--border)] transition-transform duration-150 data-checked:translate-x-3.25"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
