/** A radio group of a menu drawn as one row of segments, for a phone sheet. */
export const menuSegmentsClass = "mx-1 mb-1 grid auto-cols-fr grid-flow-col gap-0.5 rounded-md bg-surface-2 p-0.75";

/** One segment of `menuSegmentsClass`: the check mark gives way to a raised fill. */
export const menuSegmentClass =
  "justify-center px-2 py-1.75 pl-2 text-muted data-checked:bg-surface data-checked:font-medium data-checked:text-text data-checked:shadow-sticker data-checked:ring-1 data-checked:ring-border data-highlighted:bg-surface [&_[data-slot=dropdown-menu-radio-item-indicator]]:hidden";
