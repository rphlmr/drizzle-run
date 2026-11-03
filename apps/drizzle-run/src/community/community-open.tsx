import { pairSideName } from "@drizzle-run/core/pair";
import { InfoIcon } from "lucide-react";
import { useState } from "react";
import { useFetcher } from "react-router";

import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog";
import { SideBySideTag } from "../ui/side-by-side-tag";
import { CommunityOwner, CommunityTag } from "./community-card";
import type { CommunityShare } from "./contract";
import {
  formatSharedDate,
  formatShareDialects,
  getDialectName,
  getEffectSuffix,
  sortFilesForTabs,
} from "./share-labels";

/** "Don't show this again for community shares", kept in this browser's settings. */
export const COMMUNITY_NOTICE_SETTING = "community-notice-dismissed";

/** Props of the notice: the listed share, whether it shows, and what its two buttons do. */
export interface CommunityOpenProps {
  share: CommunityShare;
  open: boolean;
  onOpenCopy: () => void;
  onCancel: () => void;
}

/**
 * The notice over a Community share's page
 *
 * Open a copy closes it on the temporary copy, which runs only on Run, and remembers "Don't show this again" when
 * ticked. Cancel, Escape and a click outside call `onCancel`. Show it only while this browser has not dismissed it.
 */
export function CommunityOpen({ share, open, onOpenCopy, onCancel }: CommunityOpenProps) {
  const hideNotice = useFetcher();
  const [dontShowAgain, setDontShowAgain] = useState(false);

  const openCopy = () => {
    if (dontShowAgain) {
      void hideNotice.submit(
        { intent: "hide_notice" },
        { method: "post", action: "/community", defaultShouldRevalidate: false },
      );
    }

    onOpenCopy();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100dvh-32px)] w-[min(480px,calc(100vw-24px))] max-w-none flex-col gap-4 overflow-y-auto rounded-[18px] p-6 max-phone:w-[min(480px,calc(100vw-24px))]"
      >
        <div className="flex flex-col items-start gap-2">
          <span className="flex gap-1.5">
            <CommunityTag>Community share</CommunityTag>
            {share.sides && <SideBySideTag />}
          </span>
          <DialogTitle className="leading-[1.15]">Open “{share.title}”?</DialogTitle>
          <span className="flex items-center gap-1.5 text-[13px] text-muted">
            Shared by <CommunityOwner owner={share.owner} />
          </span>
          {share.sides ? (
            <>
              <span className="text-[13px] text-muted">
                {formatShareDialects(share)}, shared {formatSharedDate(share)}
              </span>
              <ul className="grid gap-1 text-[13px]" aria-label="Versions">
                {share.sides.map((side, index) => (
                  <li key={index}>
                    <b className="font-semibold">
                      {side.name ?? pairSideName({ ormVersion: side.orm, guestFlavor: side.guestFlavor })}
                    </b>{" "}
                    <span className="text-muted">{getDialectName(side.dialect)}</span>{" "}
                    <span className="font-mono text-[12px] text-muted">
                      orm {side.orm} · kit {side.kit}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <span className="text-[13px] text-muted">
              {getDialectName(share.releasePair.dialect)} ·{" "}
              <span className="font-mono text-[12px]">
                orm {share.releasePair.orm} · kit {share.releasePair.kit}
                {getEffectSuffix(share.releasePair)}
              </span>
              , shared {formatSharedDate(share)}
            </span>
          )}
          <ul className="flex flex-wrap gap-1.5" aria-label="Files">
            {sortFilesForTabs(share.files).map((file) => (
              <li key={file} className="rounded-[6px] bg-surface-2 px-2 py-0.75 font-mono text-[12px]">
                {file}
              </li>
            ))}
          </ul>
        </div>
        <div role="note" className="flex gap-3 rounded-[12px] border border-border bg-surface p-3.5 leading-[1.55]">
          <InfoIcon className="mt-px size-4.5 shrink-0" aria-hidden="true" />
          <DialogDescription
            render={<div />}
            className="m-0 flex flex-col gap-1.5 text-[14px] leading-[1.55] text-muted"
          >
            <b className="font-semibold text-text">Not an official example</b>
            <span>
              Someone in the community shared this. The Drizzle team hasn't checked it, so we can't promise it works,
              uses current APIs, or follows best practices.
            </span>
            <span>
              {share.sides
                ? "It opens as your own side-by-side copy and runs like any project: only in your browser, and only when you press Run. Run runs both sides."
                : "It runs like any project: only in your browser, and only when you press Run."}
            </span>
          </DialogDescription>
        </div>
        <label className="flex min-h-touch cursor-pointer items-center gap-2.5 text-[13px] text-muted max-phone:min-h-touch">
          <Checkbox className="size-4" checked={dontShowAgain} onCheckedChange={setDontShowAgain} />
          Don't show this again for community shares
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="outline" className="h-10.5 rounded-md px-4" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="sticker" className="h-10.5 rounded-md px-4.5" onClick={openCopy}>
            Open a copy
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
