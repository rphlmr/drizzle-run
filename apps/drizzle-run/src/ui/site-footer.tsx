import { useState } from "react";

import { cn } from "../lib/utils";
import { CreditsDialog } from "./credits-dialog";
import { AUTHOR_HREF, ISSUES_HREF, SOURCE_HREF } from "./project-links";

const footerLinkClass = cn("font-semibold text-accent-text hover:text-text");

/** The bar under every site page: the author link, what runs, the source, issues, and the credits. */
export function SiteFooter({ className }: { className?: string }) {
  const [creditsOpen, setCreditsOpen] = useState(false);

  return (
    <footer
      className={cn(
        "relative z-1 flex h-11 shrink-0 items-center gap-4 border-t border-border bg-bg/90 px-6 text-[13px] text-muted",
        "max-phone:h-auto max-phone:flex-col max-phone:items-start max-phone:gap-2 max-phone:px-4 max-phone:py-3",
        className,
      )}
    >
      <span>
        Made by{" "}
        <a className={footerLinkClass} href={AUTHOR_HREF} target="_blank" rel="noopener noreferrer">
          @rphlmr
        </a>
        . Follow on X for updates.
      </span>
      <span className="ml-auto max-phone:ml-0">Runs real Drizzle ORM and Kit in your browser.</span>
      <a className={footerLinkClass} href={SOURCE_HREF} target="_blank" rel="noopener noreferrer">
        GitHub
      </a>
      <a className={footerLinkClass} href={ISSUES_HREF} target="_blank" rel="noopener noreferrer">
        Report an issue
      </a>
      <button
        type="button"
        className="h-7.5 rounded-base border border-border bg-surface px-2.5 font-medium text-text hover:bg-surface-2 max-phone:relative max-phone:h-9 max-phone:px-3 max-phone:after:absolute max-phone:after:inset-x-0 max-phone:after:-inset-y-1"
        aria-haspopup="dialog"
        onClick={() => setCreditsOpen(true)}
      >
        What we use
      </button>
      <CreditsDialog open={creditsOpen} onOpenChange={setCreditsOpen} />
    </footer>
  );
}
