import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { cn } from "../lib/utils";
import { SOURCE_HREF } from "./project-links";

/** The open source projects a run depends on, each with its official site. */
export const CREDITS = [
  {
    name: "PGlite",
    description: "Postgres compiled to WebAssembly. Every PostgreSQL project runs on a fresh PGlite database.",
    href: "https://pglite.dev",
    label: "pglite.dev",
  },
  {
    name: "SQLite Wasm",
    description: "SQLite compiled to WebAssembly. Every SQLite project runs on a fresh in-memory database.",
    href: "https://sqlite.org/wasm/",
    label: "sqlite.org/wasm",
  },
  {
    name: "QuickJS-WASI",
    description: "Runs your code in a fresh JavaScript realm inside an isolated WebAssembly sandbox.",
    href: "https://www.npmjs.com/package/quickjs-wasi",
    label: "quickjs-wasi",
  },
  {
    name: "XState",
    description: "State machines behind running, sharing, and importing projects.",
    href: "https://stately.ai/docs/xstate",
    label: "stately.ai",
  },
] as const;

/** The Drizzle ORM site. */
export const DRIZZLE_HREF = "https://orm.drizzle.team";

const linkClass = cn("font-semibold text-accent-text hover:text-text");

export interface CreditsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Show runtime dependencies and their official sites. */
export function CreditsDialog({ open, onOpenChange }: CreditsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-w-130 flex-col gap-3.5 rounded-[18px] p-6 text-[14px]">
        <DialogHeader className="gap-1.5 pr-10">
          <DialogTitle>What we use</DialogTitle>
          <DialogDescription className="m-0 leading-normal">
            Your code runs in your browser, not on our servers. These open source projects make that possible.
          </DialogDescription>
        </DialogHeader>
        <ul className="m-0 list-none p-0" aria-label="Open source projects">
          {CREDITS.map((credit) => (
            <li
              key={credit.name}
              className="grid grid-cols-[96px_minmax(0,1fr)] gap-3.5 border-t border-border py-3 max-phone:grid-cols-1 max-phone:gap-1"
            >
              <span className="font-display text-[17px] font-bold">{credit.name}</span>
              <span className="flex flex-col gap-1">
                <span className="leading-normal text-soft">{credit.description}</span>
                <a
                  className={cn(linkClass, "text-[13px]")}
                  href={credit.href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {credit.label} <span aria-hidden="true">↗</span>
                </a>
              </span>
            </li>
          ))}
        </ul>
        <p className="m-0 border-t border-border pt-3 leading-normal text-muted">
          And{" "}
          <a className={linkClass} href={DRIZZLE_HREF} target="_blank" rel="noopener noreferrer">
            Drizzle ORM and Drizzle Kit
          </a>
          , in the exact pair your project picks.
        </p>
        <p className="m-0 leading-normal text-muted">
          Drizzle Run itself is open source under the AGPL-3.0 license.{" "}
          <a className={linkClass} href={SOURCE_HREF} target="_blank" rel="noopener noreferrer">
            Source on GitHub <span aria-hidden="true">↗</span>
          </a>
        </p>
        <p className="m-0 text-[12px] leading-normal text-muted">
          Drizzle, Drizzle ORM and Drizzle Kit are trademarks of Drizzle LLC.
        </p>
      </DialogContent>
    </Dialog>
  );
}
