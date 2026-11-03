"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { cn } from "../../lib/utils";

function Segmented({ className, ...props }: TabsPrimitive.Root.Props) {
  return <TabsPrimitive.Root data-slot="segmented" className={className} {...props} />;
}

const segmentedIndicatorClass = cn(
  "absolute top-(--active-tab-top) left-(--active-tab-left) h-(--active-tab-height) w-(--active-tab-width) rounded-sm bg-surface shadow-[0_0_0_1px_var(--border)] transition-[left,width] duration-(--motion-fast) ease-out",
);

function SegmentedList({
  className,
  indicatorClassName,
  children,
  ...props
}: TabsPrimitive.List.Props & {
  /** The selected fill, such as `rounded-base bg-segment shadow-none`; the item keeps its active text style. */
  indicatorClassName?: string;
}) {
  return (
    <TabsPrimitive.List
      data-slot="segmented-list"
      className={cn("relative flex items-center gap-0.5 rounded-md bg-surface-2 p-0.75", className)}
      activateOnFocus={false}
      {...props}
    >
      <TabsPrimitive.Indicator
        data-slot="segmented-indicator"
        className={cn(segmentedIndicatorClass, indicatorClassName)}
      />
      {children}
    </TabsPrimitive.List>
  );
}

function SegmentedItem({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="segmented-item"
      className={cn(
        "relative rounded-sm border-0 bg-transparent px-3 py-1.5 text-[13px] font-medium whitespace-nowrap text-muted data-active:text-text",
        className,
      )}
      {...props}
    />
  );
}

function SegmentedPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return <TabsPrimitive.Panel data-slot="segmented-panel" className={className} {...props} />;
}

export { Segmented, SegmentedList, SegmentedItem, SegmentedPanel };
