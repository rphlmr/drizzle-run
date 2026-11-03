import { XIcon } from "lucide-react";
import { useId } from "react";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { getCapabilityCopy, type CapabilityReport, type CapabilitySurface } from "./capability-copy";
import { useCopyFeedback } from "./clipboard";
import { LogoTile } from "./logo-tile";

export interface CapabilityMessageProps {
  capabilities: CapabilityReport;
  surface: CapabilitySurface;
  /** The link "Copy link to this project" copies. */
  linkToCopy?: string;
  onExport?: () => void;
  onRetry?: () => void;
  /** Where "Open in a new tab" goes. */
  openHref?: string;
}

const leadClass = cn("leading-[1.6] text-muted");
const actionsClass = cn("flex flex-wrap gap-2");
const actionClass = cn("min-h-touch rounded-md px-[18px]");
const phoneActionClass = cn("h-12 w-full rounded-[12px]");

const badges: Record<CapabilityReport["status"], string> = {
  browser_unsupported: "Browser not supported",
  embedding_context_unsupported: "This page can't host it",
  configuration_error: "Setup problem",
  available: "",
};

/** Explains why this browser cannot run projects, with the recovery actions that fit the surface. */
export function CapabilityMessage({
  capabilities,
  surface,
  linkToCopy,
  onExport,
  onRetry,
  openHref,
}: CapabilityMessageProps) {
  const titleId = useId();
  const linkCopy = useCopyFeedback();
  const copy = getCapabilityCopy(capabilities, surface);
  const unsupported = capabilities.status === "browser_unsupported";
  const embed = surface === "embed";
  const phone = surface === "phone";
  const featureList = unsupported && surface === "app";

  return (
    <div className="flex w-140 max-w-full flex-col gap-4">
      <section
        className={cn(
          "flex flex-col gap-4.5 rounded-[18px] border-[1.5px] border-card-border bg-surface p-7 text-left text-text shadow-sticker-lg",
          phone && "gap-3.5 rounded-[16px] p-5 shadow-sticker-card",
          embed && "gap-3 rounded-[16px] p-4.5 shadow-sticker-card",
        )}
        role="alert"
        aria-labelledby={titleId}
      >
        <div className={cn("flex flex-col gap-2", (phone || embed) && "contents")}>
          {embed ? (
            <span className="inline-flex items-center gap-1.5 self-start font-display text-[14px] font-extrabold tracking-[-0.02em]">
              <LogoTile small />
              <span>
                Drizzle <span className="rounded-[3px] bg-lime px-1 text-on-lime">Run</span>
              </span>
            </span>
          ) : (
            <span className="self-start rounded-full bg-err-bg px-2.25 py-0.75 text-[12px] font-semibold text-err">
              {badges[capabilities.status]}
            </span>
          )}
          <h1
            id={titleId}
            className={cn(
              "font-display text-[30px]/[1.15] font-extrabold tracking-[-0.02em]",
              phone && "text-[25px]/[1.15] tracking-normal",
              embed && "text-[20px]/[1.2] font-bold tracking-normal",
            )}
          >
            {copy.title}
          </h1>
          {featureList && (
            <p className={leadClass}>
              Each run gets an isolated database, and that needs a few features this browser doesn't provide:
            </p>
          )}
        </div>
        {featureList ? (
          <ul className="flex flex-col gap-2">
            {copy.lines.map((line, index) => (
              <li key={index} className="flex items-center gap-2.5 rounded-[10px] bg-surface-2 px-3 py-2.5">
                <XIcon aria-hidden="true" className="size-3.75 shrink-0 stroke-3 text-err" />
                {line}
              </li>
            ))}
          </ul>
        ) : (
          copy.lines.map((line, index) => (
            <p key={index} className={cn(leadClass, phone && "leading-[1.55]", embed && "leading-[1.55]")}>
              {line}
            </p>
          ))
        )}
        {unsupported && surface === "app" && (
          <p className="leading-[1.6]">
            Open this page in a current version of <strong>Chrome</strong> or <strong>Firefox</strong>, or in{" "}
            <strong>Safari 26</strong> or later.
            {" A different tab in this browser won't help."}
          </p>
        )}
        {unsupported && phone && (
          <p className="leading-[1.55]">
            Open this link in <strong>Safari</strong> or <strong>Chrome</strong>.
          </p>
        )}
        {copy.action === "copy_link_and_export" && (
          <div className={cn(actionsClass, phone && "flex-col gap-3.5")}>
            {linkToCopy && (
              <Button
                variant="sticker"
                className={phone ? phoneActionClass : actionClass}
                onClick={() => linkCopy.copy(linkToCopy)}
              >
                {linkCopy.outcome === "copied" ? "Link copied" : phone ? "Copy link" : "Copy link to this project"}
              </Button>
            )}
            {onExport && (
              <Button variant="outline" className={phone ? phoneActionClass : actionClass} onClick={onExport}>
                Export my projects
              </Button>
            )}
            {/* Stays mounted while empty, so the live region is ready. */}
            <p
              className={cn(
                "basis-full text-[13px] leading-[1.6] text-err",
                phone && linkCopy.outcome !== "failed" && "-mt-3.5",
              )}
            >
              <output>
                {linkCopy.outcome === "failed" ? "Couldn't copy the link. Copy it from the address bar instead." : ""}
              </output>
            </p>
          </div>
        )}
        {copy.action === "open_new_tab" && openHref && (
          <div className={actionsClass}>
            <Button
              variant="sticker"
              className={cn(actionClass, embed && "h-10.5 min-h-0 rounded-md px-4")}
              nativeButton={false}
              render={
                <a href={openHref} target="_blank" rel="noreferrer">
                  Open in a new tab ↗
                </a>
              }
            />
          </div>
        )}
        {copy.action === "retry" && onRetry && (
          <div className={actionsClass}>
            <Button variant="outline" className={phone ? phoneActionClass : actionClass} onClick={onRetry}>
              Try again
            </Button>
          </div>
        )}
        {unsupported && surface === "app" && (
          <p className="border-t border-border pt-3.5 text-[13px] leading-[1.6] text-muted">
            Your projects are still saved in this browser. You can read and export them here, but you can't run them.
          </p>
        )}
      </section>
      {unsupported && phone && (
        <p className="mx-1 text-[13px] leading-[1.55] text-muted">
          Your projects are still saved in this browser. You can read and export them, but not run them.
        </p>
      )}
    </div>
  );
}
