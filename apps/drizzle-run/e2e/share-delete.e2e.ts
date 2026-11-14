import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { signInWithGitHub } from "./github";
import { callStore } from "./store";

async function publishFromDialog(page: Page): Promise<string> {
  const dialog = page.getByRole("dialog");

  await dialog.getByRole("radio", { name: "Link only" }).click();
  await dialog.getByRole("checkbox", { name: /secrets/ }).click();
  await dialog.getByRole("button", { name: "Create link", exact: true }).click();
  await expect(dialog.getByText("Your link is ready.")).toBeVisible({ timeout: 60_000 });

  const url = await dialog.getByRole("textbox", { name: "Link", exact: true }).inputValue();
  await page.keyboard.press("Escape");

  return url;
}

async function pushFromDialog(page: Page) {
  const dialog = page.getByRole("dialog");

  await dialog.getByRole("checkbox", { name: /nothing private/ }).click();
  await dialog.getByRole("button", { name: "Update share", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Share updated." })).toBeVisible({
    timeout: 60_000,
  });
  await expect(dialog).toBeHidden();
}

test("should delete a share with its recorded run and keep the local project", async ({ page }) => {
  await signInWithGitHub(page.request);
  await page.goto("/");
  await page.getByRole("button", { name: /^SQLite/ }).click();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });

  const marker = `// delete-share ${crypto.randomUUID()}`;
  const editor = page.locator(".monaco-editor .view-lines");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(`\n${marker}\n`);
  await expect(editor).toContainText(marker);

  await page.getByRole("button", { name: "Share", exact: true }).click();
  const url = await publishFromDialog(page);

  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n// second version\n");
  await expect(editor).toContainText("second version");
  await page.getByRole("button", { name: "Update share", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await pushFromDialog(page);

  const apiPath = new URL(url).pathname.replace("/s/", "/api/playgrounds/");
  expect((await page.request.get(apiPath)).status()).toBe(200);

  await page.getByRole("button", { name: "Shared", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Share", exact: true })).toBeVisible();
  const stopSharing = dialog.getByRole("button", { name: "Stop sharing…", exact: true });

  await stopSharing.click();
  await expect(dialog.getByRole("heading", { name: "Stop sharing?" })).toBeVisible();
  await expect(dialog).toContainText("stays in My projects");
  await expect(dialog).toContainText("Copies people already made stay theirs");
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(dialog.getByRole("heading", { name: "Share", exact: true })).toBeVisible();
  await expect(stopSharing).toBeFocused();
  expect((await page.request.get(apiPath)).status()).toBe(200);

  await stopSharing.click();
  await dialog.getByRole("button", { name: "Stop sharing", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  expect((await page.request.get(apiPath)).status()).toBe(404);

  await expect(editor).toContainText(marker);
  await expect(editor).toContainText("second version");
  await expect(
    page.getByRole("contentinfo").getByRole("button", { name: "Local. Where this project is kept" }),
  ).toBeVisible();
  const stored = (await callStore(page, "loadProjects")).find((project) =>
    JSON.stringify(project.manifest).includes(marker),
  );

  if (stored === undefined) {
    throw new Error("Expected the local project to stay in the store.");
  }

  expect(await callStore(page, "readShareLink", stored.id)).toBeUndefined();

  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: /^Share / })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Publish to Community", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
});
