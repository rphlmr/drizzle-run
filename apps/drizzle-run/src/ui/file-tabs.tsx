import { PlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Segmented, SegmentedItem, SegmentedList } from "../components/ui/segmented";
import { cn } from "../lib/utils";
import { Hint } from "./hint";
import { SidesIcon } from "./icons";

export interface FileTabsProps {
  files: readonly string[];
  selected: string;
  onSelect: (path: string) => void;
  onAdd?: () => void;
  /** Extra controls for the selected file, shown after the tabs. */
  trailing?: ReactNode;
  /** A sunken track in the header, or touch-sized pills in a phone's row. */
  layout?: "header" | "phone";
  /** A side-by-side project's file: its hint, and whether each side has its own copy. */
  describe?: (path: string) => { hint: string; perSide: boolean };
  /** Files an AI chat edit changed, waiting for Keep or Undo: a dot on their tab. */
  pending?: ReadonlySet<string>;
  /** Files runs skip, such as a seed that is off: dimmed, with an Off mark. */
  skipped?: ReadonlySet<string>;
  /** Files TypeScript marks with an error, each with what its mark says, such as "TypeScript errors": a red dot. */
  errors?: ReadonlyMap<string, string>;
}

/** The project's file tabs, with an optional add button and the selected file's controls. */
export function FileTabs({
  files,
  selected,
  onSelect,
  onAdd,
  trailing,
  layout = "header",
  describe,
  pending,
  skipped,
  errors,
}: FileTabsProps) {
  const phone = layout === "phone";

  return (
    <div
      className={cn(
        "flex w-max items-center gap-0.5 rounded-md bg-surface-2 p-0.75",
        phone &&
          "gap-1.5 bg-transparent p-0 **:data-[size=icon-sm]:relative **:data-[size=icon-sm]:size-9 **:data-[size=icon-sm]:after:absolute **:data-[size=icon-sm]:after:-inset-1.25",
      )}
      data-guide="files"
    >
      <Segmented
        value={selected}
        onValueChange={(value) => {
          if (typeof value === "string") {
            onSelect(value);
          }
        }}
      >
        <SegmentedList
          aria-label="Project files"
          className={cn("bg-transparent p-0", phone && "gap-1.5")}
          indicatorClassName={phone ? "rounded-pill bg-segment shadow-none" : undefined}
        >
          {files.map((path) => {
            const described = describe?.(path);
            const edited = pending?.has(path) === true;
            const off = skipped?.has(path) === true;
            const error = errors?.get(path);

            return (
              <Hint key={path} content={described?.hint}>
                <SegmentedItem
                  value={path}
                  className={cn(
                    "font-mono text-[12.5px] data-active:font-semibold",
                    (described || edited || off || error !== undefined) && "inline-flex items-center gap-1.5",
                    off && "text-faint",
                    described && "px-2.75 text-[12px]",
                    phone &&
                      "relative h-9 rounded-pill border border-border px-3 py-0 text-[12px] after:absolute after:inset-x-0 after:-inset-y-1.25 data-active:border-segment data-active:text-segment-fg",
                  )}
                >
                  {path}
                  {described?.perSide && (
                    <SidesIcon className="size-2.75 stroke-[2.4] text-accent-text" label="Differs per side" />
                  )}
                  {off && (
                    <span className="rounded-[4px] border border-border px-1 font-sans text-[10px]/3.5 font-[550] text-muted">
                      Off
                    </span>
                  )}
                  {error !== undefined && (
                    <Hint content={error}>
                      <span className="size-1.75 shrink-0 rounded-full bg-err" data-slot="tab-error">
                        <span className="sr-only">{error}</span>
                      </span>
                    </Hint>
                  )}
                  {edited && (
                    <Hint content="Pending edit">
                      <span className="size-1.75 shrink-0 rounded-full bg-accent-text">
                        <span className="sr-only">Pending edit</span>
                      </span>
                    </Hint>
                  )}
                </SegmentedItem>
              </Hint>
            );
          })}
        </SegmentedList>
      </Segmented>
      {onAdd && (
        <button
          type="button"
          className={cn(
            "grid size-7.5 place-items-center rounded-sm border-0 bg-transparent text-muted hover:bg-surface hover:text-text",
            phone && "relative size-9 rounded-pill border border-border after:absolute after:-inset-1.25",
          )}
          aria-label="Add helper file"
          onClick={onAdd}
        >
          <PlusIcon aria-hidden="true" />
        </button>
      )}
      {trailing}
    </div>
  );
}
