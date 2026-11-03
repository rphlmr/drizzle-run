import { CheckIcon, FlagIcon } from "lucide-react";
import { useState } from "react";
import { useFetcher } from "react-router";

import { Button } from "../components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../components/ui/popover";
import { CopyLinkButton } from "../share/copy-link-button";
import { Hint } from "../ui/hint";
import { SideBySideTag } from "../ui/side-by-side-tag";
import type { communityAction } from "./community-page";
import type { CommunityShare } from "./contract";
import { localReportedShares } from "./reported-shares";
import {
  formatFileCount,
  formatSharedDate,
  formatShareDialects,
  getCommunitySharePath,
  getEffectSuffix,
  getSharePairLabel,
  getSharePairTitle,
} from "./share-labels";

/** Who listed a share: their GitHub avatar and @login. */
export function CommunityOwner({ owner }: { owner: CommunityShare["owner"] }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <img
        src={owner.avatarUrl}
        alt=""
        width={16}
        height={16}
        loading="lazy"
        referrerPolicy="no-referrer"
        className="size-4 shrink-0 rounded-full bg-surface-2"
      />
      <span className="truncate">@{owner.login}</span>
    </span>
  );
}

/** The bordered tag that marks community content: "Community" on cards, "Community share" in the notice. */
export function CommunityTag({ children }: { children: string }) {
  return (
    <span className="shrink-0 rounded-[4px] border border-card-border px-1.75 py-px text-[11px] font-bold whitespace-nowrap">
      {children}
    </span>
  );
}

/** Props of a Community card: the share, and what opening it does. */
export interface CommunityCardProps {
  share: CommunityShare;
  onOpen: (share: CommunityShare) => void;
}

/**
 * One listed share and the GitHub account that listed it. The whole card is a link to the share: a click
 * shows the notice first, a modified click opens it in a new tab. Copy link and Report sit above that hit area.
 */
export function CommunityCard({ share, onOpen }: CommunityCardProps) {
  return (
    <article className="relative flex min-w-0 flex-1 flex-col gap-2 rounded-lg border border-border bg-surface p-4 text-text has-[[data-open]:hover]:border-muted">
      <span className="flex items-center gap-2 text-[12px] text-muted">
        <CommunityTag>Community</CommunityTag>
        {share.sides && <SideBySideTag />}
        <span>{formatShareDialects(share)}</span>
        {!share.sides && (
          <Hint content={getSharePairTitle(share)}>
            <span className="relative z-1 ml-auto truncate font-mono">{getSharePairLabel(share)}</span>
          </Hint>
        )}
      </span>
      <h2 className="font-display text-[18px] font-bold wrap-anywhere">{share.title}</h2>
      {share.description && <p className="text-[13px]/[1.5] text-muted">{share.description}</p>}
      {share.sides && (
        <Hint content={getSharePairTitle(share)}>
          <ul className="relative z-1 flex w-fit flex-wrap gap-1.5" aria-label="Versions">
            {share.sides.map((side, index) => (
              <li key={index} className="rounded-[6px] bg-surface-2 px-1.75 py-0.5 font-mono text-[11.5px]">
                {side.name !== undefined && `${side.name} · `}
                orm {side.orm}
                {getEffectSuffix(side)}
              </li>
            ))}
          </ul>
        </Hint>
      )}
      <span className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
        <CommunityOwner owner={share.owner} />
        <span aria-hidden="true">·</span>
        <span>{formatFileCount(share)}</span>
        <span aria-hidden="true">·</span>
        <span>Shared {formatSharedDate(share)}</span>
        <span className="ml-auto flex items-center gap-1">
          <CopyLinkButton
            linkId={share.id}
            title={share.title}
            variant="text"
            className="relative z-1 after:absolute after:inset-x-0 after:-inset-y-2"
          />
          <ReportAction share={share} />
          <a
            href={getCommunitySharePath(share)}
            data-open
            className="rounded-base text-[13px] font-semibold whitespace-nowrap text-text after:absolute after:inset-0 after:rounded-lg hover:underline"
            aria-label={`Open a copy of ${share.title}`}
            onClick={(event) => {
              // A modified click opens the link in a new tab or window, as any link does.
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                return;
              }

              event.preventDefault();
              onOpen(share);
            }}
          >
            Open a copy →
          </a>
        </span>
      </span>
    </article>
  );
}

function ReportAction({ share }: { share: CommunityShare }) {
  const report = useFetcher<typeof communityAction>();
  const [confirming, setConfirming] = useState(false);
  const sending = report.state !== "idle";
  const error = !sending && report.data?.status === "failed" ? report.data.error : "";

  if (report.data?.status === "reported" || localReportedShares.has(share.id)) {
    return (
      <output className="relative z-1 mr-2 inline-flex items-center gap-1 whitespace-nowrap">
        <CheckIcon className="size-3.5" aria-hidden="true" />
        Reported
      </output>
    );
  }

  const cancel = () => {
    setConfirming(false);
    report.reset();
  };

  const send = () => {
    void report.submit(
      { intent: "report", shareId: share.id },
      { method: "post", action: "/community", defaultShouldRevalidate: false },
    );
  };

  return (
    <Popover
      open={confirming || sending}
      onOpenChange={(next) => {
        if (next) {
          setConfirming(true);
        } else if (!sending) {
          cancel();
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="relative z-1 mr-1 min-h-7 px-2 text-[12px] font-normal text-muted after:absolute after:inset-x-0 after:-inset-y-2 hover:text-text"
            aria-label={`Report ${share.title}`}
          />
        }
      >
        <FlagIcon className="size-3.5" aria-hidden="true" />
        Report
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex w-[min(300px,calc(100vw-24px))] flex-col gap-2.5 rounded-[12px] border-[1.5px] border-card-border p-3.5 text-[13px] shadow-[var(--shadow-sticker-card),var(--shadow-pop)]"
      >
        <PopoverTitle className="text-[14px] font-semibold">Report this share?</PopoverTitle>
        <p className="leading-normal text-muted">
          The Drizzle Run maintainers look at reported shares and unlist the ones that don't belong here.
        </p>
        {error && (
          <p className="text-err" role="alert">
            {error}
          </p>
        )}
        <span className="flex justify-end gap-2">
          <Button variant="outline" size="sm" disabled={sending} onClick={cancel}>
            Cancel
          </Button>
          <Button variant="default" size="sm" disabled={sending} onClick={send}>
            {sending ? "Reporting…" : error ? "Retry" : "Report"}
          </Button>
        </span>
      </PopoverContent>
    </Popover>
  );
}
