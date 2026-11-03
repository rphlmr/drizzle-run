import { ArrowRightIcon, ExternalLinkIcon } from "lucide-react";
import { Link } from "react-router";

import { cn } from "../lib/utils";
import type { ExampleLink } from "./source";

const kindLabel = { docs: "Docs", notes: "Notes", example: "Example" } as const;

/** Where the links sit: the example's note bar, or a panel card. */
export type LinkSurface = "bar" | "panel";

const kindTones: Record<LinkSurface, Record<ExampleLink["kind"], string>> = {
  bar: { docs: "bg-surface-2 text-muted", notes: "bg-notes text-text", example: "bg-lime text-on-lime" },
  panel: { docs: "bg-surface-2 text-text", notes: "bg-notes text-text", example: "bg-lime text-on-lime" },
};

/** Links with their kind as a small tag. Docs and notes open a new tab; examples stay in Drizzle Run. */
export function LinkList({ links, surface = "bar" }: { links: readonly ExampleLink[]; surface?: LinkSurface }) {
  return (
    <span
      className={cn(
        "flex flex-wrap items-center gap-3",
        surface === "bar"
          ? "ml-auto max-phone:ml-0 max-phone:basis-full max-phone:pl-6.5"
          : "flex-col flex-nowrap items-start gap-1.5",
      )}
    >
      {links.map((link) => (
        <ExampleLinkItem
          key={link.kind === "example" ? `example:${link.slug}` : `${link.kind}:${link.url}`}
          link={link}
          surface={surface}
        />
      ))}
    </span>
  );
}

/** One docs, notes or example link, tagged with its kind. */
export function ExampleLinkItem({ link, surface = "bar" }: { link: ExampleLink; surface?: LinkSurface }) {
  const className = cn(
    "inline-flex items-center gap-1.5 font-medium text-accent-text no-underline [&>svg]:size-3.25",
    surface === "panel" && "gap-2",
  );
  const tag = (
    <span className={cn("rounded-[4px] px-1.5 py-px text-[11px] font-semibold", kindTones[surface][link.kind])}>
      {kindLabel[link.kind]}
    </span>
  );

  if (link.kind === "example") {
    return (
      <Link to={`/examples/${link.slug}`} className={className}>
        {tag}
        {link.label}
        <ArrowRightIcon aria-hidden="true" />
      </Link>
    );
  }

  return (
    <a href={link.url} target="_blank" rel="noreferrer" className={className}>
      {tag}
      {link.label}
      <ExternalLinkIcon aria-hidden="true" />
    </a>
  );
}
