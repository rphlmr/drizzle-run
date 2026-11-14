import { GlobeIcon, Link2Icon } from "lucide-react";

import { Button } from "../components/ui/button";
import type { ShareStatus } from "../share/share-status";

export interface ShareButtonProps {
  shareStatus: ShareStatus;
  /** Opens the Share dialog: its first step, or the shared link. */
  onShare: () => void;
  /** Opens the Share dialog on its Update share step. */
  onPush: () => void;
}

/**
 * The header's Share button
 *
 * It says who can see the project's share, In Community or Shared for a link only, and, once the project changed
 * since what its link shows, offers Update share beside it.
 */
export function ShareButton({ shareStatus, onShare, onPush }: ShareButtonProps) {
  if (shareStatus.status === "not_shared") {
    return (
      <Button variant="outline" className="font-semibold" onClick={onShare}>
        Share
      </Button>
    );
  }

  const label = shareStatus.listed ? "In Community" : "Shared";
  const Icon = shareStatus.listed ? GlobeIcon : Link2Icon;

  if (shareStatus.status === "published") {
    return (
      <Button variant="outline" className="font-semibold" onClick={onShare}>
        <Icon aria-hidden="true" />
        {label}
      </Button>
    );
  }

  return (
    <div className="flex">
      <Button
        variant="outline"
        className="relative rounded-r-none font-semibold focus-visible:z-1"
        aria-label={label}
        onClick={onShare}
      >
        <Icon aria-hidden="true" />
      </Button>
      <Button
        variant="outline"
        className="relative -ml-px rounded-l-none font-semibold focus-visible:z-1"
        onClick={onPush}
      >
        <span aria-hidden="true" className="size-1.75 rounded-full bg-warn" />
        Update share
      </Button>
    </div>
  );
}
