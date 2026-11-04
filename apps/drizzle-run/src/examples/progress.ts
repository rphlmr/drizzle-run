import type { GuideProgress } from "@drizzle-run/runtime/machines";

import { TimestampSchema } from "../lib/api";
import type { SettingStore } from "../store/storage";
import type { OfficialExample } from "./catalog";

export type ExampleProgress = "not_viewed" | "viewed" | "in_progress" | "completed";

/** Visits are local to this browser and to the published example version. */
export function getExampleViewedSetting(exampleId: string): string {
  return `example-viewed:${exampleId}`;
}

/** Read valid visit timestamps without letting an unavailable preference hide the catalog. */
export async function readExampleViews(
  settings: SettingStore,
  examples: readonly OfficialExample[],
): Promise<Readonly<Record<string, string>>> {
  const entries = await Promise.all(
    examples.map(async ({ id, slug }) => {
      const saved = await settings.readSetting(getExampleViewedSetting(id)).catch(() => undefined);
      const parsed = TimestampSchema.safeParse(saved);

      return parsed.success ? [[slug, parsed.data] as const] : [];
    }),
  );

  return Object.fromEntries(entries.flat());
}

/** Completion wins over a revisit; saved guide progress also proves an earlier visit. */
export function getExampleProgress({
  progress,
  viewedAt,
}: {
  progress?: GuideProgress;
  viewedAt?: string;
}): ExampleProgress {
  if (progress?.finished) {
    return "completed";
  }

  if (progress && progress.completed.length > 0) {
    return "in_progress";
  }

  return progress || viewedAt ? "viewed" : "not_viewed";
}
