import { cn } from "../lib/utils";

/** The four bars of the Drizzle mark as line ends, left to right, in its 317 by 166 viewBox. */
export const drizzleMarkBars = [
  [59, 74, 14, 151.5],
  [155, 14, 110, 92],
  [207, 74, 162, 151.5],
  [303, 14.5, 258, 92],
] as const;

/** The Drizzle mark in its lime tile: 30 px in the header, 22 px beside a small wordmark. */
export function LogoTile({ small = false, className }: { small?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "grid size-7.5 shrink-0 place-items-center rounded-base border-[1.5px] border-run-border bg-logo shadow-action",
        small && "size-5.5 rounded-[6px]",
        className,
      )}
      aria-hidden="true"
    >
      <svg className={cn("h-2.5 w-4.75", small && "h-1.75 w-3.5")} viewBox="0 0 317 166" fill="none">
        <g className="stroke-logo-fg" strokeWidth="30" strokeLinecap="round">
          {drizzleMarkBars.map(([x1, y1, x2, y2]) => (
            <line key={x1} x1={x1} y1={y1} x2={x2} y2={y2} />
          ))}
        </g>
      </svg>
    </span>
  );
}
