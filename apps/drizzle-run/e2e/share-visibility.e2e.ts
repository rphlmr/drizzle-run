import { expect, test } from "./fixtures";
import { signInWithGitHub } from "./github";

test("should keep the share controls and dialog geometry stable while saving choices", async ({ page }) => {
  await signInWithGitHub(page.request);
  await page.goto("/");
  await page.getByRole("button", { name: /^SQLite/ }).click();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox", { name: /secrets/ }).click();
  await dialog.getByRole("button", { name: "Publish to Community", exact: true }).click();
  await expect(dialog.getByText(/Listed under @octocat/)).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "In Community", exact: true }).click();
  await expect(dialog.getByRole("note")).toContainText("Shows your latest code");

  for (const choice of ["A Drizzle bug", "How something works", "Link only", "Community"]) {
    const pending = Promise.withResolvers<void>();
    const intercepted = Promise.withResolvers<void>();
    await page.route("**/api/playgrounds/*/listing", async (route) => {
      intercepted.resolve();
      await pending.promise;
      await route.continue();
    });

    const control = dialog.getByRole("radio", { name: choice, exact: true });
    const before = await dialog.boundingBox();
    const listed = choice !== "Community";
    await control.click();
    await intercepted.promise;
    try {
      await expect(control).toBeVisible();
      await expect(control).toBeChecked();
      await expect(control).toBeDisabled();
      await expect(control).toHaveCSS("opacity", "1");
      await expect(dialog.getByRole("radio", { name: "A Drizzle bug" })).toHaveCount(listed ? 1 : 0);
      expect(await dialog.boundingBox()).toEqual(before);
    } finally {
      pending.resolve();
    }
    await expect(control).toBeEnabled();
    await expect(control).toBeChecked();
    await expect(dialog.getByRole("radio", { name: "A Drizzle bug" })).toHaveCount(choice === "Link only" ? 0 : 1);
    await page.unroute("**/api/playgrounds/*/listing");
  }
});
