import { useActorRef, useSelector } from "@xstate/react";
import { CheckIcon, LinkIcon } from "lucide-react";
import { useState } from "react";

import { getCommunitySharePath } from "../community/share-labels";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { Hint } from "../ui/hint";
import { createClipboardMachine } from "./clipboard-machine";

export interface CopyLinkButtonProps {
  /** The shared link's id, as in `/s/<linkId>`. */
  linkId: string;
  /** What the link shares, for the accessible name: "Copy the link to <title>". */
  title: string;
  /** `text` shows "Copy link" beside the icon; `icon` shows the icon alone, with a hint. */
  variant: "text" | "icon";
  className?: string;
}

/** Copies a share's full URL, then confirms it in place and to screen readers. */
export function CopyLinkButton({ linkId, title, variant, className }: CopyLinkButtonProps) {
  const [clipboardMachine] = useState(() =>
    createClipboardMachine({ writeText: (text) => navigator.clipboard.writeText(text) }),
  );
  const clipboard = useActorRef(clipboardMachine);
  const copied = useSelector(clipboard, (snapshot) => snapshot.matches("copied"));
  const failed = useSelector(clipboard, (snapshot) => snapshot.matches("failed"));
  const Icon = copied ? CheckIcon : LinkIcon;
  const label = copied ? "Copied" : failed ? "Couldn't copy" : "Copy link";

  const button = (
    <Button
      variant="ghost"
      size={variant === "icon" ? "icon-sm" : "xs"}
      className={cn(variant === "text" && "min-h-7 px-2 text-[12px] font-normal text-muted hover:text-text", className)}
      aria-label={`Copy the link to ${title}`}
      onClick={() =>
        clipboard.send({
          type: "clipboard.copy",
          text: new URL(getCommunitySharePath({ id: linkId }), window.location.origin).href,
          message: "Link copied.",
        })
      }
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {variant === "text" && label}
    </Button>
  );

  return (
    <>
      {variant === "icon" ? <Hint content={label}>{button}</Hint> : button}
      <span aria-live="polite" className="sr-only">
        {copied ? "Link copied." : failed ? "The link could not be copied." : ""}
      </span>
    </>
  );
}
