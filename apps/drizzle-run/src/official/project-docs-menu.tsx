import { BookOpenIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";

import { Button } from "../components/ui/button";
import { Drawer, DrawerContent, DrawerTitle } from "../components/ui/drawer";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../components/ui/popover";
import { cn } from "../lib/utils";
import { Hint } from "../ui/hint";
import { projectActionClass } from "../ui/project-actions";
import { PHONE_QUERY, useMediaQuery } from "../ui/use-media-query";
import type { DocsLink, ProjectDocs } from "./project-docs";

const KIND_LABELS = {
  docs: "Docs",
  notes: "Notes",
  example: "Example",
  link: "Link",
} as const satisfies Record<DocsLink["kind"], string>;

const KIND_TONES = {
  docs: "bg-mark text-accent-text",
  notes: "bg-surface-2 text-muted",
  example: "bg-lime text-on-lime",
  link: "bg-surface-2 text-muted",
} as const satisfies Record<DocsLink["kind"], string>;

const rowClass = cn(
  "flex min-h-9 items-center gap-2 rounded-base px-2.5 text-[13px] text-text no-underline hover:bg-surface-2 max-phone:min-h-touch",
);

/** One link, tagged with its kind unless its label already says it. Examples stay in Drizzle Run; the rest open a new tab. */
function DocsLinkRow({ link, onNavigate }: { link: DocsLink; onNavigate: () => void }) {
  const internal = link.href.startsWith("/");
  const kind = KIND_LABELS[link.kind];
  const content = (
    <>
      {kind !== link.label && (
        <span
          className={cn(
            "inline-flex h-4.5 shrink-0 items-center rounded-pill px-2 text-[10.5px] font-semibold",
            KIND_TONES[link.kind],
          )}
        >
          {kind}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{link.label}</span>
      <span className="text-muted" aria-hidden="true">
        {internal ? "→" : "↗"}
      </span>
    </>
  );

  return internal ? (
    <Link to={link.href} className={rowClass} onClick={onNavigate}>
      {content}
    </Link>
  ) : (
    <a href={link.href} target="_blank" rel="noopener noreferrer" className={rowClass}>
      {content}
    </a>
  );
}

/** Documentation source, return link and section links for an official project. */
function DocsList({ docs, title, onNavigate }: { docs: ProjectDocs; title: ReactNode; onNavigate: () => void }) {
  const { page } = docs;

  return (
    <>
      <div className="flex flex-col gap-1 px-2.5 pt-2 pb-1.5">
        <div className="flex items-baseline gap-2">
          {title}
          <span className="text-[12px] text-muted">From the {docs.from}</span>
        </div>
        <span className="font-display text-[17px]/[1.2] font-[750] tracking-[-0.01em]">{docs.title}</span>
      </div>
      {(page.status === "same" || page.status === "newer") && (
        <Link
          to={page.href}
          className="mx-1 mb-1 flex min-h-9 items-center gap-2 rounded-base border border-border bg-surface-2 px-2.5 text-[13px] font-semibold text-text no-underline max-phone:min-h-touch"
          onClick={onNavigate}
        >
          {page.status === "newer" ? "Open the latest version" : `Open the ${docs.from} again`}
          <span className="ml-auto" aria-hidden="true">
            →
          </span>
        </Link>
      )}
      {page.status === "removed" && (
        <p className="mx-1 mb-1 rounded-base bg-surface-2 px-2.5 py-2.25 text-[12.5px] text-muted">
          This {docs.from} was removed.
        </p>
      )}
      {docs.groups.map((group) => (
        <section key={group.title} aria-label={group.title} className="flex flex-col">
          <h3 className="m-0 px-2.5 pt-2 pb-1 text-[12px] font-semibold text-muted">{group.title}</h3>
          <ul className="m-0 flex list-none flex-col p-0">
            {group.links.map((link) => (
              <li key={link.href}>
                <DocsLinkRow link={link} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="mt-1 border-t border-border p-2.5 text-[12px]/normal text-muted">
        From the version you forked, so they match your code.
      </p>
    </>
  );
}

const titleClass = cn("text-[13.5px] font-[650]");

/** Props of `ProjectDocsMenu`: the docs `resolveProjectDocs` found for the project's source. */
export interface ProjectDocsMenuProps {
  docs: ProjectDocs;
}

/**
 * The header's Docs
 *
 * The links of the official example or guide version the project was forked from: a popover from the project actions
 * box on desktop, and a bottom sheet from the header's book icon on a phone.
 */
export function ProjectDocsMenu({ docs }: ProjectDocsMenuProps) {
  const phone = useMediaQuery(PHONE_QUERY);
  const [open, setOpen] = useState(false);
  const label = `Docs from the ${docs.from}`;
  const close = () => setOpen(false);

  if (phone) {
    return (
      <>
        <Button
          variant="outline"
          size="icon"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <BookOpenIcon aria-hidden="true" />
        </Button>
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent className="max-h-[78%] gap-0.5 overflow-y-auto rounded-t-[18px] border-[1.5px] border-b-0 border-card-border px-2 pt-2 pb-5 text-[13px]">
            <span className="mt-0.5 mb-1.5 h-1 w-9 shrink-0 self-center rounded-full bg-border" aria-hidden="true" />
            <DocsList docs={docs} title={<DrawerTitle className={titleClass}>Docs</DrawerTitle>} onNavigate={close} />
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint content="Docs">
        <PopoverTrigger className={projectActionClass} aria-label={label}>
          <BookOpenIcon aria-hidden="true" />
        </PopoverTrigger>
      </Hint>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="flex w-[min(360px,calc(100vw-24px))] flex-col gap-0.5 rounded-[12px] border-[1.5px] border-card-border p-1.5 text-[13px] shadow-[var(--shadow-sticker-card),var(--shadow-pop)]"
      >
        <DocsList docs={docs} title={<PopoverTitle className={titleClass}>Docs</PopoverTitle>} onNavigate={close} />
      </PopoverContent>
    </Popover>
  );
}
