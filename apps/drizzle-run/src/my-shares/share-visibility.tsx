import { cn } from "../lib/utils";
import { KindBadge } from "../ui/kind-badge";

/** Who can find a share: anyone with its link, or also everyone browsing Community. */
export type ShareVisibility = "link_only" | "community" | "removed";

const visibilityLabels: Record<ShareVisibility, string> = {
  link_only: "Link only",
  community: "In Community",
  removed: "Removed from Community",
};

/** Who can find a share, as a badge; a Community bug repro says so. */
export function ShareVisibilityBadge({ visibility, bugRepro }: { visibility: ShareVisibility; bugRepro: boolean }) {
  return (
    <KindBadge
      tone={visibility === "community" ? "lime" : "neutral"}
      className={cn(visibility === "removed" && "text-err")}
    >
      {visibilityLabels[visibility]}
      {visibility === "community" && bugRepro && " · Bug repro"}
    </KindBadge>
  );
}
