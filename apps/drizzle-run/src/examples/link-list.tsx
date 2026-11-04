import { ArrowRightIcon, ExternalLinkIcon } from "lucide-react";
import { Link } from "react-router";

import { cn } from "../lib/utils";
import type { ExampleLink } from "./source";

const kindLabel = { docs: "Docs", notes: "Notes", example: "Example" } as const;

/** Where the links sit: the example's note bar, or a panel card. */
export type LinkSurface = "bar" | "panel";

const kindTones: Record<LinkSurface, Record<ExampleLink["kind"], string>> = {
  bar: { docs: "bg-surface-2 text-muted", notes: "bg-notes text-text", example: "bg-lime text-on-lime" },
  panel: { docs: "bg-surface-2 text-muted", notes: "bg-surface-2 text-muted", example: "bg-surface-2 text-muted" },
};

/** Links with their kind as a small tag. Docs and notes open a new tab; examples stay in Drizzle Run. */
export function LinkList({ links, surface = "bar" }: { links: readonly ExampleLink[]; surface?: LinkSurface }) {
  return (
    <span
      className={cn(
        "flex flex-wrap items-center gap-3",
        surface === "bar"
          ? "ml-auto max-phone:ml-0 max-phone:basis-full max-phone:pl-6.5"
          : "flex-col flex-nowrap items-stretch gap-0.5",
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
    "inline-flex items-center gap-1.5 font-medium no-underline [&>svg]:size-3.25",
    surface === "bar"
      ? "text-accent-text"
      : "w-full rounded-md px-2 py-2 text-[13px] text-text hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent-text [&>svg]:shrink-0 [&>svg]:text-muted",
  );
  const tag = (
    <span className={cn("rounded-[4px] px-1.5 py-px text-[11px] font-semibold", kindTones[surface][link.kind])}>
      {kindLabel[link.kind]}
    </span>
  );

  if (link.kind === "example") {
    return (
      <Link to={`/examples/${link.slug}`} className={className}>
        {surface === "bar" && tag}
        <span className={cn(surface === "panel" && "min-w-0 flex-1")}>{link.label}</span>
        {surface === "panel" && tag}
        <ArrowRightIcon aria-hidden="true" />
      </Link>
    );
  }

  return (
    <a href={link.url} target="_blank" rel="noreferrer" className={className}>
      {surface === "bar" && tag}
      <span className={cn(surface === "panel" && "min-w-0 flex-1")}>{link.label}</span>
      {surface === "panel" && tag}
      <ExternalLinkIcon aria-hidden="true" />
    </a>
  );
}
