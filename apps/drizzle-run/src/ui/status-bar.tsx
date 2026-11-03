import { useState, type ReactNode } from "react";

import { cn } from "../lib/utils";
import { CreditsDialog } from "./credits-dialog";
import { AUTHOR_HREF, ISSUES_HREF, SOURCE_HREF } from "./project-links";

/** The runtime's state, as the status bar shows it. */
export type RuntimeStatus = "ready" | "preparing" | "failed";

const runtimeLabels: Record<RuntimeStatus, string> = {
  ready: "Runtime ready",
  preparing: "Preparing runtime",
  failed: "Runtime unavailable",
};

const runtimeDots: Record<RuntimeStatus, string> = {
  ready: "bg-accent-text",
  preparing: "bg-warn",
  failed: "bg-err",
};

export interface StatusBarProps {
  /** The database, such as "PostgreSQL", or "PostgreSQL vs SQLite" beside two sides. */
  databaseLabel: string;
  /** The release control (picker trigger) for the project's ORM and Kit pair. */
  release: ReactNode;
  runtime: RuntimeStatus;
  /** Replaces the runtime's words, such as "Both runtimes ready" beside two sides. */
  runtimeLabel?: string;
  /** The save state: its words, or a control built around them. */
  save: ReactNode;
  trailing?: ReactNode;
}

/** The bar under the playground: the database, the release control, the runtime, and the save state. */
export function StatusBar({ databaseLabel, release, runtime, runtimeLabel, save, trailing }: StatusBarProps) {
  const [creditsOpen, setCreditsOpen] = useState(false);

  return (
    <footer className="flex h-status shrink-0 items-center gap-3 overflow-hidden border-t border-border bg-surface px-4 text-[11.5px] whitespace-nowrap text-muted max-phone:h-touch max-phone:scrollbar-none max-phone:gap-3 max-phone:overflow-x-auto max-phone:px-3">
      <span className="font-semibold text-text">{databaseLabel}</span>
      {release}
      <span className="flex min-w-31 items-center gap-1.5" data-slot="runtime-status">
        <span className={cn("size-1.75 rounded-full", runtimeDots[runtime])} aria-hidden="true" />
        {runtimeLabel ?? runtimeLabels[runtime]}
      </span>
      <span className="ml-auto max-phone:hidden">{typeof save === "string" ? <output>{save}</output> : save}</span>
      {trailing}
      <button
        type="button"
        className="border-0 bg-transparent p-0 font-semibold text-text hover:text-accent-text max-phone:hidden"
        aria-haspopup="dialog"
        onClick={() => setCreditsOpen(true)}
      >
        What we use
      </button>
      <a
        className="font-semibold text-accent-text hover:text-text max-phone:hidden"
        href={SOURCE_HREF}
        target="_blank"
        rel="noopener noreferrer"
      >
        GitHub
      </a>
      <a
        className="font-semibold text-accent-text hover:text-text max-phone:hidden"
        href={ISSUES_HREF}
        target="_blank"
        rel="noopener noreferrer"
      >
        Report an issue
      </a>
      <a
        className="font-semibold text-accent-text hover:text-text max-phone:hidden"
        href={AUTHOR_HREF}
        target="_blank"
        rel="noopener noreferrer"
      >
        @rphlmr
      </a>
      <CreditsDialog open={creditsOpen} onOpenChange={setCreditsOpen} />
    </footer>
  );
}
