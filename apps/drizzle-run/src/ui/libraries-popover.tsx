import type { DatabaseTarget } from "@drizzle-run/core/catalog";
import { PackageIcon } from "lucide-react";

import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../components/ui/popover";
import { cn } from "../lib/utils";
import { Hint } from "./hint";
import { listReleaseLibraries, type ReleaseCurrent } from "./release-options";

export interface LibrariesPopoverProps {
  target: DatabaseTarget;
  current: ReleaseCurrent;
  /** Matches the height of the version chip beside it. */
  size?: "status_bar" | "pane";
}

/**
 * The libraries button beside a version chip
 *
 * Opens a list of the libraries the Drizzle version ships and their versions. Renders nothing when there are none.
 */
export function LibrariesPopover({ target, current, size = "status_bar" }: LibrariesPopoverProps) {
  const libraries = listReleaseLibraries(target, current);

  if (libraries.length === 0) {
    return null;
  }

  return (
    <Popover>
      <Hint content="Libraries" side="top">
        <PopoverTrigger
          render={<button type="button" aria-label="Libraries" />}
          className={cn(
            "relative inline-flex shrink-0 items-center justify-center rounded-[6px] border border-border bg-surface-2 text-muted after:absolute after:-inset-x-1 after:-inset-y-2.5 hover:border-faint hover:text-text data-popup-open:text-text data-popup-open:shadow-[0_0_0_2px_var(--lime)] max-phone:min-h-touch max-phone:min-w-touch [&>svg]:stroke-[2.2]",
            size === "status_bar" ? "size-5.5 [&>svg]:size-3" : "size-6 [&>svg]:size-3.25",
          )}
          data-slot="libraries"
        >
          <PackageIcon aria-hidden="true" />
        </PopoverTrigger>
      </Hint>
      <PopoverContent
        side="top"
        className="flex w-[min(320px,calc(100vw-24px))] flex-col gap-1 rounded-[12px] border-[1.5px] border-card-border p-1.5 text-[13px] shadow-[var(--shadow-sticker-card),var(--shadow-pop)]"
      >
        <div className="flex items-baseline gap-2 px-2.5 pt-2">
          <PopoverTitle className="text-[13.5px] font-[650]">Libraries</PopoverTitle>
          <span className="text-[12px] text-muted">Shipped with this Drizzle version</span>
        </div>
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 px-2.5 pt-1 pb-2">
          {libraries.map(({ packageName, version }) => (
            <div key={packageName} className="contents">
              <dt className="truncate text-text">{packageName}</dt>
              <dd className="font-mono text-[11.5px] text-muted">{version}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}
