import type { ReactNode } from "react";
import { Link } from "react-router";

import { cn } from "../lib/utils";
import { LogoTile } from "../ui/logo-tile";
import { AccountMenu } from "./account-menu";

export interface AppHeaderProps {
  leading?: ReactNode;
  tabs?: ReactNode;
  actions?: ReactNode;
  /** Where the logo goes. The embed opens the full app in a new tab. */
  homeHref?: string;
  homeTarget?: "_blank";
  /** The compact embed drops the logo to give its controls the room. */
  logo?: boolean;
  /** The embed's shorter header. */
  compact?: boolean;
  /** Site pages keep "Drizzle Run" beside the tile on phones; pages with a project title show the tile alone. */
  phoneWordmark?: boolean;
  /**
   * The playground's phone header: 56 px on the surface, with its controls drawn at 36 px and a 44 px hit area.
   * Without it, phone controls draw at 44 px.
   */
  playground?: boolean;
  /** The account menu at the right end. Embeds leave it out: they have no AuthProvider. */
  account?: boolean;
  className?: string;
}

/**
 * The header of every page: the logo, the leading content, the embed's file tabs, then the actions and the account on
 * the right.
 */
export function AppHeader({
  leading,
  tabs,
  actions,
  homeHref = "/",
  homeTarget,
  logo = true,
  compact = false,
  phoneWordmark = false,
  playground = false,
  account = !compact,
  className,
}: AppHeaderProps) {
  return (
    <header
      className={cn(
        "group/header flex h-header min-w-0 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 max-phone:h-15 max-phone:gap-2 max-phone:px-3",
        playground && "max-phone:h-header max-phone:gap-2.5 max-phone:bg-surface",
        compact && "h-12 bg-surface px-2.5 max-phone:h-12 max-phone:px-2.5",
        className,
      )}
      data-playground={playground || undefined}
    >
      {logo && (
        <Link
          className="inline-flex shrink-0 items-center gap-2.25 font-display text-[19px] font-extrabold tracking-[-0.03em] whitespace-nowrap text-text no-underline max-phone:gap-2 max-phone:text-[18px]"
          to={homeHref}
          target={homeTarget}
          rel={homeTarget ? "noopener noreferrer" : undefined}
          aria-label="Drizzle Run home"
        >
          <span className="relative shrink-0">
            <LogoTile className="max-phone:size-8" />
            <span className="absolute -right-2.5 -bottom-1.5 rounded-full border border-bg bg-text px-1 font-sans text-[8px] leading-3 font-bold tracking-[0.06em] text-bg uppercase">
              Beta
            </span>
          </span>
          <span className={cn(!phoneWordmark && "max-phone:hidden")}>
            Drizzle <span className="rounded-[5px] bg-lime px-1.25 text-on-lime">Run</span>
          </span>
        </Link>
      )}
      {leading !== undefined && (
        <div className="flex min-w-0 shrink items-center gap-2 max-phone:-m-1 max-phone:flex-1 max-phone:overflow-hidden max-phone:p-1">
          {leading}
        </div>
      )}
      {tabs !== undefined && (
        <div className="min-w-0 flex-[0_1_auto] scrollbar-none overflow-x-auto [&::-webkit-scrollbar]:hidden">
          {tabs}
        </div>
      )}
      <div
        className={cn(
          "ml-auto flex shrink-0 items-center gap-2",
          playground
            ? "max-phone:gap-2.5 max-phone:**:data-size:relative max-phone:**:data-size:after:absolute max-phone:**:data-size:after:-inset-1.25 max-phone:**:data-[size=icon]:border-transparent max-phone:**:data-[size=icon]:bg-transparent max-phone:**:data-[size=run]:h-9 max-phone:**:data-[size=run]:gap-1.5 max-phone:**:data-[size=run]:rounded-[9px] max-phone:**:data-[size=run]:px-3 max-phone:**:data-[size=run]:text-[13px] max-phone:**:data-[size=run]:font-bold max-phone:**:data-[size=run]:after:inset-[-5.5px]"
            : "max-phone:gap-1.5 max-phone:**:data-size:min-h-touch max-phone:**:data-[size=icon]:size-touch",
        )}
      >
        {actions}
      </div>
      {account && (
        <div className={cn("flex shrink-0 items-center border-l border-border pl-3", playground && "max-phone:hidden")}>
          <AccountMenu />
        </div>
      )}
    </header>
  );
}
