import { BookOpenIcon, FolderIcon, InfoIcon, PlusIcon, UsersIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router";

import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { cn } from "../lib/utils";
import { CreditsDialog } from "../ui/credits-dialog";
import { phoneSheetClass, phoneSheetProps } from "../ui/phone-sheet";
import { AUTHOR_HREF, ISSUES_HREF, SOURCE_HREF } from "../ui/project-links";
import { SiteFooter } from "../ui/site-footer";
import { PHONE_QUERY, useMediaQuery } from "../ui/use-media-query";
import { useWorkspace } from "../workspace/context";
import { AppHeader } from "./app-header";

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "inline-flex items-center justify-center gap-2 rounded-base px-3 py-1.75 text-[13px] font-medium whitespace-nowrap no-underline transition-colors",
    // Phones: a tab bar at the bottom, an icon over each label, the current tab's icon on a pill.
    "group/tab max-phone:flex-1 max-phone:flex-col max-phone:gap-0.5 max-phone:rounded-none max-phone:pt-1.5 max-phone:pb-1 max-phone:text-[11px]",
    isActive
      ? "bg-surface-2 text-text max-phone:bg-transparent"
      : "text-muted hover:bg-surface-2 hover:text-text max-phone:hover:bg-transparent",
  );

const NAV = [
  {
    to: "/examples",
    label: "Examples & Guides",
    phoneLabel: "Examples",
    icon: BookOpenIcon,
  },
  {
    to: "/projects",
    label: "My projects",
    phoneLabel: "Projects",
    icon: FolderIcon,
  },
  {
    to: "/community",
    label: "Community",
    phoneLabel: "Community",
    icon: UsersIcon,
  },
] as const;

/** The site sections: in the site header, and beside the project in the desktop editor header. */
export function SiteNav({
  phone,
  iconsUnderWide = false,
  className,
}: {
  phone: boolean;
  /** Shows the links as icons under 1280px, where an editor header also holds the project title and actions. */
  iconsUnderWide?: boolean;
  className?: string;
}) {
  // A project page belongs to My projects.
  const inProject = useLocation().pathname.startsWith("/p/");

  return (
    <nav
      className={cn(
        "flex gap-1 max-phone:shrink-0 max-phone:gap-0 max-phone:border-t max-phone:border-border max-phone:bg-surface max-phone:px-2 max-phone:pb-[env(safe-area-inset-bottom)]",
        className,
      )}
      aria-label="Main"
    >
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) =>
            cn(
              navLinkClass({ isActive: isActive || (inProject && item.to === "/projects") }),
              iconsUnderWide && "max-[1280px]:px-2.25",
            )
          }
          aria-current={inProject && item.to === "/projects" ? "page" : undefined}
          title={iconsUnderWide ? item.label : undefined}
        >
          <TabIcon icon={item.icon} />
          <span className={cn(iconsUnderWide && "max-[1280px]:sr-only")}>{phone ? item.phoneLabel : item.label}</span>
        </NavLink>
      ))}
      {phone && <AboutTab />}
    </nav>
  );
}

/** A nav icon; on phones it sits on a pill that fills in for the current tab or an open menu. */
function TabIcon({ icon: Icon }: { icon: typeof InfoIcon }) {
  return (
    <span className="contents max-phone:flex max-phone:h-7 max-phone:w-14 max-phone:items-center max-phone:justify-center max-phone:rounded-full max-phone:transition-colors max-phone:group-aria-[current=page]/tab:bg-surface-2 max-phone:group-data-popup-open/tab:bg-surface-2">
      <Icon className="size-4 max-phone:size-5" aria-hidden="true" />
    </span>
  );
}

/** Phones: the site footer as a fourth tab, opening a sheet with the author, the source, issues and the credits. */
function AboutTab() {
  const [creditsOpen, setCreditsOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className={cn(navLinkClass({ isActive: false }), "data-popup-open:text-text")}>
          <TabIcon icon={InfoIcon} />
          About
        </DropdownMenuTrigger>
        <DropdownMenuContent {...phoneSheetProps} className={phoneSheetClass}>
          <span aria-hidden="true" className="mx-auto mb-2 block h-1 w-9 rounded-pill bg-card-border" />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Runs real Drizzle ORM and Kit in your browser.</DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => setCreditsOpen(true)}>What we use</DropdownMenuItem>
            <DropdownMenuItem
              render={
                <a href={SOURCE_HREF} target="_blank" rel="noopener noreferrer">
                  GitHub
                </a>
              }
            />
            <DropdownMenuItem
              render={
                <a href={ISSUES_HREF} target="_blank" rel="noopener noreferrer">
                  Report an issue
                </a>
              }
            />
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              render={
                <a href={AUTHOR_HREF} target="_blank" rel="noopener noreferrer">
                  Made by @rphlmr · follow on X for updates
                </a>
              }
            />
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreditsDialog open={creditsOpen} onOpenChange={setCreditsOpen} />
    </>
  );
}

/**
 * The page panel under the header: it scrolls the main landmark, then the site footer below it
 *
 * `fill` is for a page that scrolls a region of its own: the panel stays still, the page fills it and draws the site
 * footer where its scroll ends, on phones too.
 */
export function SiteMain({ className, fill, children }: { className?: string; fill?: boolean; children: ReactNode }) {
  return (
    <div
      data-site-scroller
      className={cn(
        "flex min-h-0 w-full flex-1 flex-col rounded-lg border border-border bg-surface shadow-sticker max-phone:rounded-none max-phone:border-x-0 max-phone:border-b-0 max-phone:shadow-none",
        fill ? "overflow-hidden" : "[scrollbar-gutter:stable] overflow-y-auto",
      )}
    >
      <main
        className={cn(
          "mx-auto flex w-full max-w-400 grow flex-col gap-5 px-8 pt-7 pb-8 max-phone:gap-3.5 max-phone:p-4",
          fill ? "min-h-0 pb-0 max-phone:pb-0" : "shrink-0",
          className,
        )}
      >
        {children}
      </main>
      {!fill && <SiteFooter className="border-border bg-transparent" />}
    </div>
  );
}

/**
 * Header of every site page: home, My projects, the gallery, Community, and not-found
 *
 * The site layout draws it once for all of them, so it stays mounted while a page loads and between pages.
 */
export function SiteHeader() {
  const workspace = useWorkspace();
  const phone = useMediaQuery(PHONE_QUERY);

  return (
    <>
      <AppHeader
        className="relative z-1 gap-5 border-b-0 bg-transparent max-phone:gap-2.5 max-phone:bg-surface"
        phoneWordmark
        leading={phone ? undefined : <SiteNav phone={false} />}
        actions={
          <Button
            variant="sticker"
            size={phone ? "icon" : "default"}
            className={cn("rounded-md", phone ? "size-9" : "h-8.5 px-3.5")}
            onClick={workspace.openCreate}
            disabled={workspace.loading}
            aria-label={phone ? "New project" : undefined}
          >
            <PlusIcon aria-hidden="true" />
            {!phone && "New project"}
          </Button>
        }
      />
    </>
  );
}
