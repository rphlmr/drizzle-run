"use client";

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckIcon } from "lucide-react";

import { cn } from "../../lib/utils";

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "grid size-4.5 shrink-0 place-items-center rounded-[5px] border-[1.5px] border-muted bg-surface p-0 text-segment-fg data-checked:border-segment data-checked:bg-segment data-disabled:cursor-not-allowed data-disabled:border-border data-disabled:bg-surface-2",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="[&_svg]:size-3.25 [&_svg]:stroke-3">
        <CheckIcon />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
