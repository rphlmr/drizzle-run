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
  // On the bar, links of one kind share a single tag in front, rather than repeating it before each link.
  const sharedKind =
    surface === "bar" && links.length > 1 && links.every((link) => link.kind === links[0].kind)
      ? links[0].kind
      : undefined;

  return (
    <span
      className={cn(
        "flex flex-wrap items-center gap-3",
        surface === "bar"
          ? "ml-auto gap-x-4 max-phone:ml-0 max-phone:basis-full max-phone:pl-6.5"
          : "flex-col flex-nowrap items-stretch gap-0.5",
      )}
    >
      {sharedKind !== undefined && <KindTag kind={sharedKind} surface={surface} />}
      {links.map((link) => (
        <ExampleLinkItem
          key={link.kind === "example" ? `example:${link.slug}` : `${link.kind}:${link.url}`}
          link={link}
          surface={surface}
          tagged={sharedKind === undefined}
        />
      ))}
    </span>
  );
}

function KindTag({ kind, surface }: { kind: ExampleLink["kind"]; surface: LinkSurface }) {
  return (
    <span className={cn("rounded-[4px] px-1.5 py-px text-[11px] font-semibold", kindTones[surface][kind])}>
      {kindLabel[kind]}
    </span>
  );
}

/** One docs, notes or example link, tagged with its kind. */
export function ExampleLinkItem({
  link,
  surface = "bar",
  tagged = true,
}: {
  link: ExampleLink;
  surface?: LinkSurface;
  /** False when the list shows one tag for all its links. */
  tagged?: boolean;
}) {
  const className = cn(
    "inline-flex items-center gap-1.5 font-medium no-underline [&>svg]:size-3.25",
    surface === "bar"
      ? "text-accent-text"
      : "w-full rounded-md px-2 py-2 text-[13px] text-text hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent-text [&>svg]:shrink-0 [&>svg]:text-muted",
  );
  const tag = tagged ? <KindTag kind={link.kind} surface={surface} /> : null;

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
