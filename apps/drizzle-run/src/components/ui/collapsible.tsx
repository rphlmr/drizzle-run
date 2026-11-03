"use client";

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";

import { cn } from "../../lib/utils";

function Collapsible({ className, ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" className={className} {...props} />;
}

function CollapsibleTrigger({ className, ...props }: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      className={cn(
        "flex w-full items-center gap-1.5 border-0 bg-transparent text-left text-[13px] font-medium text-text [&_svg]:size-3.5 [&_svg]:text-muted [&_svg]:transition-transform [&_svg]:duration-(--motion-fast) [&_svg]:ease-out data-panel-open:[&_svg]:rotate-90",
        className,
      )}
      {...props}
    />
  );
}

const collapsibleContentClass = cn(
  "h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-(--motion-base) ease-out data-ending-style:h-0 data-ending-style:duration-(--motion-fast) data-starting-style:h-0 [[data-auto-height]_&]:transition-none",
);

function CollapsibleContent({ className, ...props }: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-content"
      className={cn(collapsibleContentClass, className)}
      {...props}
    />
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
