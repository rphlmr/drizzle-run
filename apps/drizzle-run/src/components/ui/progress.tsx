"use client";

import { Progress as ProgressPrimitive } from "@base-ui/react/progress";

import { cn } from "../../lib/utils";

function Progress({ className, ...props }: ProgressPrimitive.Root.Props) {
  return (
    <ProgressPrimitive.Root data-slot="progress" className={cn("group/progress", className)} {...props}>
      <ProgressPrimitive.Track data-slot="progress-track" className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className="h-full rounded-full bg-progress transition-[width] duration-300 group-data-indeterminate/progress:w-[35%] group-data-indeterminate/progress:animate-progress-slide"
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
}

export { Progress };
