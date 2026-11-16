import { PlusIcon } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { SiteFooter } from "../ui/site-footer";
import { PHONE_QUERY, useMediaQuery } from "../ui/use-media-query";
import { useWorkspace } from "../workspace/context";
import { AppHeader } from "./app-header";
import { SITE_SECTIONS } from "./site-sections";

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "inline-flex items-center justify-center gap-2 rounded-base px-3 py-1.75 text-[13px] font-medium whitespace-nowrap no-underline transition-colors",
    isActive ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-2 hover:text-text",
  );

/** The site sections in the desktop site header, and beside the project in the desktop editor header. Phones use the menu. */
export function SiteNav({
  iconsUnderWide = false,
  className,
}: {
  /** Shows the links as icons under 1280px, where an editor header also holds the project title and actions. */
  iconsUnderWide?: boolean;
  className?: string;
}) {
  // A project page belongs to My projects.
  const inProject = useLocation().pathname.startsWith("/p/");

  return (
    <nav className={cn("flex gap-1", className)} aria-label="Main">
      {SITE_SECTIONS.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            cn(
              navLinkClass({ isActive: isActive || (inProject && to === "/projects") }),
              iconsUnderWide && "max-[1280px]:px-2.25",
            )
          }
          aria-current={inProject && to === "/projects" ? "page" : undefined}
          title={iconsUnderWide ? label : undefined}
        >
          <Icon className="size-4" aria-hidden="true" />
          <span className={cn(iconsUnderWide && "max-[1280px]:sr-only")}>{label}</span>
        </NavLink>
      ))}
    </nav>
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
        leading={phone ? undefined : <SiteNav />}
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
