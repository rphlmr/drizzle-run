import { clamp } from "es-toolkit";
import type { KeyboardEvent, PointerEvent, RefObject } from "react";
import { useEffect, useRef, useState } from "react";

import { resizeGripClassName } from "../components/ui/resizable";
import { cn } from "../lib/utils";

/** The widest a rail may grow, as a share of the row that holds it. */
const MAX_RAIL_SHARE = 0.5;
/** What a widened rail leaves to the work area after it, such as the editor and output. */
const MIN_WORK_AREA_PX = 640;
const KEYBOARD_STEP_PX = 16;

/** Where a rail stands: its rendered width and the widths it may take, `maxPx` never under `minPx`. */
type RailBounds = {
  widthPx: number;
  minPx: number;
  maxPx: number;
};

/** The rail's edge that holds the handle: `right` for a rail on the row's left, `left` for a dock on its right. */
type RailEdge = "left" | "right";

type RailResizeHandleProps = {
  /** The rail this handle widens. Its CSS `min-width` is the narrowest it goes. */
  rail: RefObject<HTMLElement | null>;
  /** Where the handle sits. The work area is the rail's next sibling for `right`, its previous one for `left`. */
  edge: RailEdge;
  /** Called with the new width in pixels, or `null` to give the rail back its drawn width. */
  onWidthChange: (widthPx: number | null) => void;
  /** Accessible name, such as "Resize guide". */
  label: string;
  className?: string;
};

/**
 * Rail resize handle
 *
 * A separator on the inner edge of a side rail, such as the guide on the left or the AI chat dock on
 * the right: drag it or use the arrow keys to move the edge, Home or a double click to give the rail
 * back its drawn width, End for the widest. The rail never gets narrower than its CSS `min-width`.
 * It grows to half its row at most, and only while the work area beside it keeps `MIN_WORK_AREA_PX`;
 * a second rail opening or widening in the same row narrows it back. With no room to move, it is not drawn.
 */
export function RailResizeHandle({ rail, edge, onWidthChange, label, className }: RailResizeHandleProps) {
  const bounds = useRailBounds(rail, edge);
  const growthDirection = edge === "right" ? 1 : -1;
  const drag = useRef<{ startX: number; startWidthPx: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const overMaxPx = bounds !== null && bounds.widthPx > bounds.maxPx + 1 ? bounds.maxPx : undefined;
  const stuck = bounds !== null && bounds.maxPx - bounds.minPx < 1;

  useEffect(() => {
    if (overMaxPx !== undefined) {
      onWidthChange(overMaxPx);
    }
  }, [overMaxPx, onWidthChange]);

  // Measured at each key press and pointer move: the observed bounds lag a frame behind a fast key
  // repeat or another rail that just changed, and a stale max would overshoot the work area.
  function getLiveBounds() {
    return rail.current ? measureRailBounds(rail.current, edge) : bounds;
  }

  function getRailWidthPx() {
    return getLiveBounds()?.widthPx ?? 0;
  }

  function resizeTo(widthPx: number) {
    const liveBounds = getLiveBounds();

    if (liveBounds === null) {
      return;
    }

    onWidthChange(clamp(widthPx, liveBounds.minPx, liveBounds.maxPx));
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (bounds === null || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidthPx: getRailWidthPx() };
    setDragging(true);
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current === null) {
      return;
    }

    resizeTo(drag.current.startWidthPx + growthDirection * (event.clientX - drag.current.startX));
  }

  function endDrag() {
    drag.current = null;
    setDragging(false);
  }

  function resizeWithKey(event: KeyboardEvent<HTMLDivElement>) {
    if (bounds === null) {
      return;
    }

    switch (event.key) {
      case "ArrowLeft": {
        resizeTo(getRailWidthPx() - growthDirection * KEYBOARD_STEP_PX);
        break;
      }

      case "ArrowRight": {
        resizeTo(getRailWidthPx() + growthDirection * KEYBOARD_STEP_PX);
        break;
      }

      case "Home": {
        onWidthChange(null);
        break;
      }

      case "End": {
        resizeTo(Infinity);
        break;
      }

      default: {
        return;
      }
    }

    event.preventDefault();
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={bounds === null ? undefined : Math.round(bounds.widthPx)}
      aria-valuemin={bounds === null ? undefined : Math.round(bounds.minPx)}
      aria-valuemax={bounds === null ? undefined : Math.round(bounds.maxPx)}
      tabIndex={0}
      hidden={stuck}
      data-separator={dragging ? "active" : "inactive"}
      className={cn("absolute inset-y-0 z-10 w-3 cursor-col-resize touch-none", resizeGripClassName, className)}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onWidthChange(null)}
      onKeyDown={resizeWithKey}
    />
  );
}

/** The rail's rendered width and limits now, or `null` for a rail outside a row. */
function measureRailBounds(railElement: HTMLElement, edge: RailEdge): RailBounds | null {
  const row = railElement.parentElement;
  const workArea = edge === "right" ? railElement.nextElementSibling : railElement.previousElementSibling;

  if (!row) {
    return null;
  }

  const rowStyle = getComputedStyle(row);
  const rowContentPx = row.clientWidth - parseFloat(rowStyle.paddingLeft) - parseFloat(rowStyle.paddingRight);
  const widthPx = railElement.getBoundingClientRect().width;
  const minPx = parseFloat(getComputedStyle(railElement).minWidth) || 0;
  const workAreaSpareWidthPx = workArea ? workArea.getBoundingClientRect().width - MIN_WORK_AREA_PX : Infinity;
  const maxPx = Math.min(rowContentPx * MAX_RAIL_SHARE, widthPx + workAreaSpareWidthPx);

  return { widthPx, minPx, maxPx: Math.max(minPx, maxPx) };
}

/** The rail's bounds, kept current as the rail, its row or its work area resize. */
function useRailBounds(rail: RefObject<HTMLElement | null>, edge: RailEdge): RailBounds | null {
  const [bounds, setBounds] = useState<RailBounds | null>(null);

  useEffect(() => {
    const railElement = rail.current;
    const row = railElement?.parentElement;
    const workArea = edge === "right" ? railElement?.nextElementSibling : railElement?.previousElementSibling;

    if (!railElement || !row) {
      return;
    }

    const observer = new ResizeObserver(() => setBounds(measureRailBounds(railElement, edge)));
    observer.observe(railElement);
    observer.observe(row);

    if (workArea) {
      observer.observe(workArea);
    }

    return () => observer.disconnect();
  }, [rail, edge]);

  return bounds;
}
