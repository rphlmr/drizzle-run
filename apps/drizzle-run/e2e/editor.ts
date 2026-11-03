import type { Page } from "@playwright/test";

import { SELECT_TO_DOCUMENT_END } from "./fixtures";

/** Replaces the open file's code through Monaco's keyboard input. */
export async function replaceEditorCode(page: Page, lines: readonly string[]): Promise<void> {
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");

  // Firefox inserts multi-line text into Monaco twice when sent in one insertText call.
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      await page.keyboard.press("Enter");
    }

    if (line.length > 0) {
      await page.keyboard.insertText(line);
    }
  }

  // Remove any closing brackets Monaco inserted beyond the typed code.
  await page.keyboard.press(SELECT_TO_DOCUMENT_END);
  await page.keyboard.press("Delete");
}
