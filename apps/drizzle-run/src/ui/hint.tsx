import type { ReactElement, ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";

export interface HintProps {
  /** The tooltip's text. Empty or missing renders the element alone. */
  content: ReactNode;
  /** One element that takes a ref and props: a button, a span, or another Base UI trigger such as a menu's. */
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
}

/**
 * A hover and focus hint drawn by the Base UI tooltip, in place of the browser's native `title`.
 *
 * The element itself becomes the trigger, so wrapping a popover or menu trigger keeps both working.
 */
export function Hint({ content, children, side }: HintProps) {
  if (content === undefined || content === null || content === false || content === "") {
    return children;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>{content}</TooltipContent>
    </Tooltip>
  );
}
