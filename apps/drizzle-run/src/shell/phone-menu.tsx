import { MenuIcon } from "lucide-react";
import { useState } from "react";
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
import { SITE_SECTIONS } from "./site-sections";

/**
 * Phones: the button that opens the site sections and the links about Drizzle Run, in a sheet
 *
 * Every phone header starts with it, a project's included, so the way to the rest of the app never moves.
 */
export function PhoneMenu() {
  const [creditsOpen, setCreditsOpen] = useState(false);
  const { pathname } = useLocation();

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon" className="-ml-1.5 size-9 shrink-0" aria-label="Menu" />}
        >
          <MenuIcon className="size-5" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent {...phoneSheetProps} className={phoneSheetClass}>
          <span aria-hidden="true" className="mx-auto mb-2 block h-1 w-9 rounded-pill bg-card-border" />
          <DropdownMenuGroup>
            {SITE_SECTIONS.map(({ to, label, icon: Icon }) => {
              // A project page belongs to My projects.
              const current = pathname.startsWith(to) || (to === "/projects" && pathname.startsWith("/p/"));
              return (
                <DropdownMenuItem
                  key={to}
                  className={cn("min-h-11 gap-3", current && "bg-surface-2 font-medium")}
                  render={
                    <NavLink to={to} aria-current={current ? "page" : undefined}>
                      <Icon className="size-4.5 text-muted" aria-hidden="true" />
                      {label}
                    </NavLink>
                  }
                />
              );
            })}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Runs real Drizzle ORM and Kit in your browser.</DropdownMenuLabel>
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
