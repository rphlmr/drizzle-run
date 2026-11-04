import { configure } from "onedollarstats";

/** Start analytics only for the production build on the released origin. */
export function initializeAnalytics({ production, origin }: { production: boolean; origin: string }): void {
  if (!production || origin !== "https://drizzle.run") {
    return;
  }

  configure({ collectorUrl: `${origin}/api/analytics/events` });
}
