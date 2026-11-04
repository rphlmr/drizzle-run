import { BookOpenIcon, FolderIcon, PlusIcon, UsersIcon } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { SiteFooter } from "../ui/site-footer";
import { PHONE_QUERY, useMediaQuery } from "../ui/use-media-query";
import { useWorkspace } from "../workspace/context";
import { AppHeader } from "./app-header";

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "inline-flex items-center justify-center gap-2 rounded-base px-3 py-1.75 text-[13px] font-medium whitespace-nowrap no-underline transition-colors",
    "max-phone:flex-1 max-phone:rounded-[9px] max-phone:py-2.5 max-phone:text-center max-phone:text-[13.5px]",
    isActive ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-2 hover:text-text",
  );

const NAV = [
  { to: "/examples", label: "Examples & Guides", phoneLabel: "Examples & Guides", icon: BookOpenIcon },
  { to: "/projects", label: "My projects", phoneLabel: "Projects", icon: FolderIcon },
  { to: "/community", label: "Community", phoneLabel: "Community", icon: UsersIcon },
] as const;

function SiteNav({ phone }: { phone: boolean }) {
  return (
    <nav
      className="flex gap-1 max-phone:mx-4 max-phone:mt-4 max-phone:gap-0.5 max-phone:rounded-[12px] max-phone:bg-surface-2 max-phone:p-0.75"
      aria-label="Main"
    >
      {NAV.map((item) => (
        <NavLink key={item.to} to={item.to} className={navLinkClass}>
          <item.icon className="size-4 max-phone:hidden" aria-hidden="true" />
          {phone ? item.phoneLabel : item.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** The scrolling page column under the site header, then the site footer: My projects and the gallery. */
export function SiteMain({ className, children }: { className?: string; children: ReactNode }) {
  const phone = useMediaQuery(PHONE_QUERY);

  return (
    <>
      <main className="min-h-0 w-full flex-1 [scrollbar-gutter:stable] overflow-y-auto">
        <div
          className={cn(
            "mx-auto flex min-h-full w-full max-w-260 flex-col gap-5 px-8 pt-7 pb-8 max-phone:gap-3.5 max-phone:p-4",
            className,
          )}
        >
          {children}
          {phone && <SiteFooter className="-mx-4 mt-auto -mb-4 self-stretch" />}
        </div>
      </main>
      {!phone && <SiteFooter />}
    </>
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
        className="relative z-1 gap-5 bg-surface max-phone:gap-2.5"
        phoneWordmark
        leading={phone ? undefined : <SiteNav phone={false} />}
        actions={
          <Button
            variant="sticker"
            className="h-9 rounded-md px-4 max-phone:px-3.5"
            onClick={workspace.openCreate}
            disabled={workspace.loading}
            aria-label={phone ? "New project" : undefined}
          >
            <PlusIcon aria-hidden="true" />
            {phone ? "New" : "New project"}
          </Button>
        }
      />
      {phone && <SiteNav phone />}
    </>
  );
}
