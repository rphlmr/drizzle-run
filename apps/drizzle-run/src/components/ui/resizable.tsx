"use client";

import * as ResizablePrimitive from "react-resizable-panels";

import { cn } from "../../lib/utils";

function ResizablePanelGroup({ className, ...props }: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn("flex size-full aria-[orientation=vertical]:flex-col", className)}
      {...props}
    />
  );
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}

/**
 * Resize grip
 *
 * The short pill every resize handle draws at its middle, vertical or horizontal: hidden at rest, a 3 px by 48 px grip
 * in the scrollbar thumb's color on hover and keyboard focus, darker while dragging (`data-separator="active"`).
 * The handle keeps its full 12 px hit area. Shared so the guide rail, the chat dock and the editor/output split look
 * the same; focus keeps the app's base focus ring.
 */
export const resizeGripClassName = cn(
  "after:absolute after:top-1/2 after:left-1/2 after:h-12 after:w-[3px] after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-pill after:transition-colors hover:after:bg-faint focus-visible:after:bg-faint aria-[orientation=horizontal]:after:h-[3px] aria-[orientation=horizontal]:after:w-12 data-[separator=active]:after:bg-muted data-[separator=hover]:after:bg-faint",
);

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean;
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "relative flex w-3 items-center justify-center bg-transparent aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full",
        resizeGripClassName,
        className,
      )}
      {...props}
    >
      {withHandle && <div className="z-10 flex shrink-0" />}
    </ResizablePrimitive.Separator>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
