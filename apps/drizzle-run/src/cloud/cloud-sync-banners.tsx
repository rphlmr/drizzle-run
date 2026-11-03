import { XIcon } from "lucide-react";
import { Link } from "react-router";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { CloudSync } from "./cloud-sync";

const noticeClass = cn("flex flex-wrap items-center gap-2.5 bg-surface-2 px-4 py-2.5 text-[13px]");

/**
 * Cloud notices under the header
 *
 * Names each project changed here and on another machine, and the copy that keeps the other machine's version.
 */
export function CloudSyncBanners({ cloudSync }: { cloudSync: CloudSync }) {
  if (cloudSync.copies.length === 0) {
    return null;
  }

  return (
    <output className={noticeClass}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {cloudSync.copies.map((copy) => (
          <span key={copy.copyId}>
            <b className="font-semibold">{copy.name}</b> changed here and on another machine. The other version is in{" "}
            <Link to={`/p/${copy.copyId}`} className="font-semibold text-text">
              {copy.copyName}
            </Link>
            .
          </span>
        ))}
      </div>
      <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={cloudSync.dismissCopies}>
        <XIcon />
      </Button>
    </output>
  );
}
