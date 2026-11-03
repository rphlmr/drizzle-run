import { PAIR_SIDE_NAME_MAX_LENGTH } from "@drizzle-run/core/pair";
import { PencilIcon } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { Hint } from "../ui/hint";
import type { SideRelease } from "./side-labels";

export interface SideNameProps {
  release: SideRelease;
  /** Saves the side's name; an empty one clears it. Left out where the sides cannot change, such as a guide. */
  onRename?: (name: string) => void;
}

/** Focuses the name field once it mounts: it opens from a click on the name, which held the focus. */
function focusNameField(input: HTMLInputElement | null) {
  input?.focus();
}

const nameShrinkClass = cn("shrink-0 @max-[36rem]:shrink");

const nameButtonClass = cn(
  "relative -ml-1.5 inline-flex h-6 max-w-45 min-w-0 items-center gap-1.5 rounded-[6px] border-0 bg-transparent px-1.5 text-[13px] font-[650] whitespace-nowrap text-text after:absolute after:inset-x-0 after:-inset-y-2.5 hover:bg-surface-2",
);

/**
 * Rename a side from its pane header
 *
 * A named side shows its name, and two unnamed sides on one release show their labels, ending in " (1)" and " (2)",
 * in muted text; clicking either renames the side. An unnamed side on its own release needs no label beside its release, so it
 * shows a pencil alone. Renaming swaps in a field: Enter or leaving it saves, Escape cancels.
 */
export function SideName({ release, onRename }: SideNameProps) {
  const [renaming, setRenaming] = useState(false);
  const noteId = useId();
  const labelled = release.name !== "" || release.label !== release.short;

  if (onRename === undefined) {
    return labelled ? (
      <span className={cn("min-w-0 truncate text-[13px] font-[650]", nameShrinkClass)}>{release.label}</span>
    ) : null;
  }

  if (renaming) {
    const save = (name: string) => {
      setRenaming(false);

      if (name.trim() !== release.name) {
        onRename(name);
      }
    };
    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        save(event.currentTarget.value);
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setRenaming(false);
      }
    };

    return (
      <Tooltip open>
        <TooltipTrigger
          render={
            <input
              aria-label="Name of this side"
              aria-describedby={noteId}
              className="h-6.5 w-37.5 shrink-0 rounded-[6px] border-[1.5px] border-run-border bg-bg px-2 text-[13px] font-semibold text-text shadow-[0_0_0_2px_var(--lime)] placeholder:font-normal placeholder:text-muted focus-visible:outline-transparent"
              defaultValue={release.name}
              placeholder={release.short}
              maxLength={PAIR_SIDE_NAME_MAX_LENGTH}
              ref={focusNameField}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={handleKeyDown}
              onBlur={(event) => save(event.currentTarget.value)}
            />
          }
        />
        <TooltipContent
          side="bottom"
          sideOffset={8}
          className="grid w-65 max-w-65 gap-1 rounded-[12px] border-[1.5px] border-card-border bg-bg px-3 py-2.5 text-[12px] leading-[1.45] text-muted shadow-sticker"
        >
          <span className="font-semibold text-text">Name this side</span>
          <span id={noteId}>
            Shows on this side, in its output and in shared links. Leave it empty to use the release name.
          </span>
          <span className="font-mono text-[11px]">Enter saves · Esc cancels</span>
        </TooltipContent>
      </Tooltip>
    );
  }

  if (!labelled) {
    return (
      <Hint content="Name this side">
        <button
          type="button"
          className={cn(nameButtonClass, "w-6 justify-center px-0")}
          aria-label="Name this side"
          onClick={() => setRenaming(true)}
        >
          <PencilIcon className="size-3 text-muted" aria-hidden="true" />
        </button>
      </Hint>
    );
  }

  return (
    <Hint content="Rename this side">
      <button
        type="button"
        className={cn(nameButtonClass, nameShrinkClass)}
        aria-label={`${release.label}. Rename this side`}
        onClick={() => setRenaming(true)}
      >
        <span className={release.name === "" ? "truncate text-muted" : "truncate"}>{release.label}</span>
        <PencilIcon className="size-3 shrink-0 text-muted" aria-hidden="true" />
      </button>
    </Hint>
  );
}
