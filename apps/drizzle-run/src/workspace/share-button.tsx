import { GlobeIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import type { ShareStatus } from "../share/share-status";

export interface ShareButtonProps {
  shareStatus: ShareStatus;
  /** Opens the Share dialog on its Link tab. */
  onShare: () => void;
  /** Opens the Share dialog on its push step. */
  onPush: () => void;
}

/**
 * The header's Share button
 *
 * It says whether the project is shared and, once it changed since what its link shows, offers to push the changes
 * beside it.
 */
export function ShareButton({ shareStatus, onShare, onPush }: ShareButtonProps) {
  if (shareStatus.status === "not_shared") {
    return (
      <Button variant="outline" className="font-semibold" onClick={onShare}>
        Share
      </Button>
    );
  }

  if (shareStatus.status === "published") {
    return (
      <Button variant="outline" className="font-semibold" onClick={onShare}>
        <GlobeIcon aria-hidden="true" />
        Shared
      </Button>
    );
  }

  return (
    <div className="flex">
      <Button
        variant="outline"
        className="relative rounded-r-none font-semibold focus-visible:z-1"
        aria-label="Shared"
        onClick={onShare}
      >
        <GlobeIcon aria-hidden="true" />
      </Button>
      <Button
        variant="outline"
        className="relative -ml-px rounded-l-none font-semibold focus-visible:z-1"
        onClick={onPush}
      >
        <span aria-hidden="true" className="size-1.75 rounded-full bg-warn" />
        Push changes
      </Button>
    </div>
  );
}
