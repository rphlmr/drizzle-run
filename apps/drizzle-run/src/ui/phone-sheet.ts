/** Phones: a menu opens as a sheet from the bottom edge, as wide as the screen. */
const viewportBottom = {
  getBoundingClientRect: () => new DOMRect(0, window.innerHeight, window.innerWidth, 0),
};

/** The `DropdownMenuContent` props that open a menu as a phone sheet, with `phoneSheetClass` on it. */
export const phoneSheetProps = {
  side: "top",
  sideOffset: 0,
  anchor: viewportBottom,
  positionMethod: "fixed",
  collisionPadding: 0,
  backdrop: true,
} as const;

export const phoneSheetClass =
  "max-h-[85dvh] rounded-t-lg rounded-b-none border-x-0 border-b-0 px-2.5 pt-2 pb-[max(12px,env(safe-area-inset-bottom))]";
