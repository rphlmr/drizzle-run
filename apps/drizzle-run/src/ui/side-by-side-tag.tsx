import { cn } from "../lib/utils";
import { Hint } from "./hint";
import { SidesIcon } from "./icons";

export interface SideBySideTagProps {
  /** `header` matches the project header's uppercase tags (Official, Guided); `card` matches the gallery tags. */
  size?: "card" | "header";
  className?: string;
}

/** Marks a project, example or share that runs on two sides, at the size of the tags beside it. */
export function SideBySideTag({ size = "card", className }: SideBySideTagProps) {
  return (
    <Hint content="Every run runs both sides">
      <span
        className={cn(
          "inline-flex shrink-0 items-center font-bold whitespace-nowrap",
          size === "header"
            ? "gap-1 rounded-pill border border-card-border px-1.75 py-px text-[10.5px] tracking-[0.02em] uppercase"
            : "gap-1 rounded-[4px] bg-mark px-1.75 py-px text-[11px] text-accent-text",
          className,
        )}
      >
        <SidesIcon className={size === "header" ? "size-2.75" : "size-3"} />
        Side by side
      </span>
    </Hint>
  );
}
