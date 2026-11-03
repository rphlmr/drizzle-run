import { PAIR_SIDES, type PairSideIndex } from "@drizzle-run/core/pair";
import { MoreHorizontalIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import type { SideRelease } from "./side-labels";

export interface SideFileMenuProps {
  releases: readonly [SideRelease, SideRelease];
  /** The open file has a copy per side. */
  selectedPerSide: boolean;
  /** False when both sides cannot run one copy of the open file: Legacy next to v1, or the schema on two databases. */
  canShare: boolean;
  /** The open file is the seed, which both sides always share. */
  seedSelected: boolean;
  /** The open file is a helper, which can be renamed or deleted. */
  helperSelected: boolean;
  onShare: (side: PairSideIndex) => void;
  onSplit: () => void;
  onRename: () => void;
  onDelete: () => void;
}

/** The open file's actions: share one side's copy or give each side its own, then rename or delete a helper. */
export function SideFileMenu({
  releases,
  selectedPerSide,
  canShare,
  seedSelected,
  helperSelected,
  onShare,
  onSplit,
  onRename,
  onDelete,
}: SideFileMenuProps) {
  const sharing = selectedPerSide ? canShare : !seedSelected;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="File actions" />}>
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {sharing &&
          (selectedPerSide ? (
            PAIR_SIDES.map((side) => (
              <DropdownMenuItem key={side} onClick={() => onShare(side)}>
                Share {releases[side].label}’s copy with both sides
              </DropdownMenuItem>
            ))
          ) : (
            <DropdownMenuItem onClick={onSplit}>Give each side its own copy</DropdownMenuItem>
          ))}
        {helperSelected && (
          <>
            {sharing && <DropdownMenuSeparator />}
            <DropdownMenuItem onClick={onRename}>Rename file…</DropdownMenuItem>
            <DropdownMenuItem onClick={onDelete}>Delete file…</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
