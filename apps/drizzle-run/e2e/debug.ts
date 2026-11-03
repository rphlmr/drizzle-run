import type { Page } from "@playwright/test";

import { expect } from "./fixtures";

/** Turns Debug on from the project's ··· menu, so the next run submits debug traces, and closes the menu. */
export async function turnOnDebug(page: Page): Promise<void> {
  await page.getByRole("button", { name: "More actions" }).click();
  const debug = page.getByRole("menuitemcheckbox", { name: "Debug" });
  await debug.click();
  await expect(debug).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(debug).toBeHidden();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
}
