import { readGuideProgress, type GuideProgress } from "@drizzle-run/runtime/machines";

import type { OfficialExample } from "../examples/catalog";
import type { SettingStore } from "../store/storage";
import { getGuideProgressSetting } from "./catalog";

/** Saved progress for each guided example, by slug. A guide not started, or with unreadable progress, has none. */
export async function readExampleProgress(
  settings: SettingStore,
  examples: readonly OfficialExample[],
): Promise<Readonly<Record<string, GuideProgress>>> {
  const entries = await Promise.all(
    examples.flatMap(({ slug, guide }) =>
      guide
        ? [
            settings
              .readSetting(getGuideProgressSetting(guide.id))
              .catch(() => undefined)
              .then((saved) => [slug, readGuideProgress(saved, guide)] as const),
          ]
        : [],
    ),
  );

  return Object.fromEntries(
    entries.filter((entry): entry is readonly [string, GuideProgress] => entry[1] !== undefined),
  );
}
