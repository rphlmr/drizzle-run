import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import { useElementSizePx } from "./use-element-size";

export interface AutoHeightProps {
  /** Layout of the content, such as a flex column and its gap, which a wrapper would otherwise break. */
  className?: string;
  children: ReactNode;
}

/**
 * Auto height
 *
 * Follows its content's height with a short transition, so a dialog grows and shrinks smoothly when its content
 * changes. It starts at its content's height without a transition, so a dialog that opens or reopens never animates
 * from zero. Keep it at the same place in the tree across content states, or it remounts and snaps.
 *
 * The negative margin and matching padding keep sticker shadows and focus rings unclipped. It never shrinks in a flex
 * column, so a dialog taller than the viewport still scrolls instead of clipping. Collapsibles inside it open at once
 * (`data-auto-height`), leaving this one height animation per surface.
 */
export function AutoHeight({ className, children }: AutoHeightProps) {
  const { ref, sizePx } = useElementSizePx();

  return (
    <div
      data-auto-height=""
      className="-m-1.5 shrink-0 overflow-hidden transition-[height] duration-(--motion-base) ease-out"
      style={sizePx ? { height: sizePx.heightPx } : undefined}
    >
      <div ref={ref}>
        <div className={cn("p-1.5", className)}>{children}</div>
      </div>
    </div>
  );
}
