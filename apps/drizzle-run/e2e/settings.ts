import type { Page } from "@playwright/test";

import { callStore } from "./store";

/** A setting from the app's local store. The guide saves progress after it moves on, so tests poll it. */
export function readSetting(page: Page, key: string): Promise<unknown> {
  return callStore(page, "readSetting", key);
}
