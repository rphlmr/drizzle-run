import { projectRecord, storeProjects } from "./data";
import { expect, test } from "./fixtures";

test("should cancel pending Safari clipboard writes without an unhandled rejection", async ({ page, browserName }) => {
  test.skip(browserName !== "webkit", "Monaco installs this clipboard workaround only on WebKit.");
  await page.addInitScript(() => {
    // Safari may abandon a ClipboardItem's deferred payload without observing its rejection.
    Object.defineProperty(navigator.clipboard, "write", {
      configurable: true,
      value: async () => {
        document.documentElement.dataset.clipboardWrites = String(
          Number(document.documentElement.dataset.clipboardWrites ?? 0) + 1,
        );
      },
    });
  });
  const project = { ...projectRecord(0), id: crypto.randomUUID() };
  await storeProjects(page, [project], `/p/${project.id}`);
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });

  await page.locator(".monaco-editor .view-lines").click();
  await page.locator(".monaco-editor .view-lines").click();
  await page.locator(".monaco-editor .view-lines").click();

  await expect
    .poll(() => page.evaluate(() => Number(document.documentElement.dataset.clipboardWrites ?? 0)))
    .toBeGreaterThanOrEqual(3);
  await page.evaluate(() => new Promise(requestAnimationFrame));
});
