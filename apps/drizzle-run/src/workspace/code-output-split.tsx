import type { ReactNode } from "react";
import type { GroupProps, PanelProps } from "react-resizable-panels";

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../components/ui/resizable";
import { cn } from "../lib/utils";
import { phonePaneMotionClass, type PhoneView } from "../ui/phone-view-switch";

/** One pane of the split: its content and how it sizes. */
export interface SplitPane {
  content: ReactNode;
  /** Unique on the page, so a linked split can name the pane. */
  id?: string;
  defaultSize?: PanelProps["defaultSize"];
  minSize: PanelProps["minSize"];
}

export interface CodeOutputSplitProps extends Pick<
  GroupProps,
  "orientation" | "className" | "style" | "hidden" | "elementRef" | "groupRef" | "onLayoutChange"
> {
  phone: boolean;
  /** What a phone shows: the split hides the code while the output shows, and the output while the code shows. */
  phoneView: PhoneView;
  /** Fades each pane in as a phone switches to it. */
  motion: boolean;
  code: SplitPane;
  output: SplitPane;
  handle: {
    label: string;
    className?: string;
    disabled?: boolean;
  };
}

/**
 * Code and output split
 *
 * The code and its output in a resizable split, as a one-version project's work area and as each side of a
 * side-by-side project. A phone shows one pane at a time and has no handle. Both panes stay mounted behind `hidden`,
 * so the editor keeps its host: the panel library sets an inline display, which only the `hidden` attribute
 * (display: none !important in Tailwind's preflight) overrides.
 *
 * Without a handle shown, the panels are disabled: the panel library hit-tests a hidden handle at the page's top left,
 * where it would take the clicks meant for the header, unless at most one panel can resize.
 */
export function CodeOutputSplit({
  phone,
  phoneView,
  motion,
  code,
  output,
  handle,
  className,
  hidden,
  ...group
}: CodeOutputSplitProps) {
  const paneClassName = phone && motion ? phonePaneMotionClass : undefined;

  return (
    <ResizablePanelGroup {...group} className={className} hidden={hidden}>
      <ResizablePanel
        id={code.id}
        defaultSize={code.defaultSize}
        minSize={code.minSize}
        className={paneClassName}
        hidden={phone && phoneView === "output"}
        disabled={phone}
      >
        {code.content}
      </ResizablePanel>
      <ResizableHandle
        aria-label={handle.label}
        className={cn(phone && "hidden", handle.className)}
        disabled={handle.disabled}
      />
      <ResizablePanel
        id={output.id}
        defaultSize={output.defaultSize}
        minSize={output.minSize}
        className={paneClassName}
        hidden={phone && phoneView === "code"}
        disabled={phone}
      >
        {output.content}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
