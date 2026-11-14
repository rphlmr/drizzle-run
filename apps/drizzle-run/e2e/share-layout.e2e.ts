import { expect, test } from "./fixtures";
import { signInWithGitHub } from "./github";

test.use({ launchOptions: { chromiumSandbox: true, ignoreDefaultArgs: ["--hide-scrollbars"] } });
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "This regression exercises Chromium's classic scrollbar gutter.",
);

test("should keep every part of the shared link inside the dialog with classic scrollbars", async ({ page }) => {
  await signInWithGitHub(page.request);
  await page.setViewportSize({ width: 1280, height: 1440 });
  await page.goto("/");
  await page.getByRole("button", { name: /^SQLite/ }).click();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Link only" }).click();
  await dialog.getByRole("checkbox", { name: /secrets/ }).click();
  await dialog.getByRole("button", { name: "Create link", exact: true }).click();
  await expect(dialog.getByText("Your link is ready.")).toBeVisible({ timeout: 60_000 });
  await dialog.getByRole("button", { name: /Embed in a page/ }).click();
  await expect(dialog.getByRole("button", { name: "Copy embed code", exact: true })).toBeVisible();
  await page.addStyleTag({ content: "::-webkit-scrollbar { width: 14px; height: 14px; }" });

  for (const viewport of [
    { width: 1280, height: 600 },
    { width: 390, height: 600 },
  ]) {
    await page.setViewportSize(viewport);
    const scrollBody = dialog.locator("div.overflow-y-auto").first();
    expect(
      await scrollBody.evaluate((element) =>
        element instanceof HTMLElement ? element.offsetWidth - element.clientWidth : 0,
      ),
    ).toBeGreaterThanOrEqual(14);
    await test
      .info()
      .attach(`sharing-scrollbars-${viewport.width}`, { body: await dialog.screenshot(), contentType: "image/png" });
    expect(await scrollBody.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(
      await scrollBody.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const left = bounds.left + element.clientLeft;
        const right = left + element.clientWidth;

        return Array.from(element.querySelectorAll("button, input:not([aria-hidden]), textarea, svg"))
          .filter((control) => {
            const controlBounds = control.getBoundingClientRect();

            return controlBounds.left < left - 1 || controlBounds.right > right + 1;
          })
          .map((control) => control.getAttribute("aria-label") ?? control.textContent?.trim());
      }),
    ).toEqual([]);
    const linkField = dialog.getByRole("textbox", { name: "Link", exact: true });
    await linkField.focus();
    expect(
      await linkField.evaluate(
        (element) =>
          element instanceof HTMLInputElement &&
          element.selectionStart === 0 &&
          element.selectionEnd === element.value.length,
      ),
    ).toBe(true);
    const copyButton = dialog.getByRole("button", { name: "Copy link", exact: true });
    await copyButton.scrollIntoViewIfNeeded();
    expect(
      await copyButton.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const target = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);

        return target !== null && element.contains(target);
      }),
    ).toBe(true);
  }

  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
});
