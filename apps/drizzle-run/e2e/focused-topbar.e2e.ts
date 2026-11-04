import { projectRecord, storeProjects } from "./data";
import { expect, test } from "./fixtures";

for (const theme of ["light", "dark"] as const) {
  test(`should preserve the dotted output and raised actions in the ${theme} redesign`, async ({ page }, testInfo) => {
    await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/examples/quick-start-postgresql");
    const output = page.getByRole("region", { name: "Execution output", exact: true });
    await expect(output.getByText("Your results land here")).toBeVisible();
    await expect(output.getByRole("tabpanel")).toHaveCSS("background-image", /radial-gradient/);
    const run = page.getByRole("button", { name: /Run/ }).first();
    await expect(run).toBeEnabled();
    await expect(run).not.toHaveCSS("box-shadow", "none");
    await expect(page.getByRole("tablist", { name: "Project files" })).toBeVisible();
    if (theme === "light") {
      await expect(page.locator(".monaco-editor").first()).not.toHaveCSS("background-color", "rgb(255, 255, 255)");
    }
    await page.screenshot({ path: testInfo.outputPath(`editor-${theme}.png`) });

    await storeProjects(
      page,
      ["Blog playground", "SQLite experiments", "Query comparison"].map((name, index) => ({
        ...projectRecord(index === 0 ? 1 : index === 1 ? 0 : index),
        name,
      })),
      "/projects",
    );
    await page.route("**/api/community?*", (route) =>
      route.fulfill({
        json: {
          shares: [
            ["Cursor pagination", "Stable pagination across a changing dataset."],
            ["Nested JSON results", "Shape related rows into nested objects with typed helpers."],
            ["Transaction rollback", "A focused reproduction with a transaction and a savepoint."],
          ].map(([title, description], index) => ({
            id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            title,
            description,
            topic: "playground",
            releasePair: { dialect: "postgresql", orm: "0.45.4", kit: "0.31.11", guestFlavor: "slim" },
            files: ["query.ts", "schema.ts", "seed.ts"],
            listedAt: "2026-11-04T10:00:00.000Z",
            owner: { login: "drizzle-user", avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4" },
          })),
          nextCursor: null,
        },
      }),
    );

    for (const route of ["examples", "projects", "community"]) {
      await page.goto(`/${route}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("button", { name: "New project", exact: true })).toBeEnabled();
      const navLeft = await page
        .getByRole("navigation", { name: "Main" })
        .evaluate((element) => element.getBoundingClientRect().left);
      const logoRight = await page
        .getByRole("link", { name: "Drizzle Run home" })
        .evaluate((element) => element.getBoundingClientRect().right);
      expect(navLeft - logoRight).toBeGreaterThanOrEqual(0);
      expect(navLeft - logoRight).toBeLessThan(32);
      const background = await page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor);
      await expect(page.getByRole("banner")).not.toHaveCSS("background-color", background);
      if (route === "projects") {
        await expect(page.getByRole("link", { name: "Blog playground", exact: true })).toBeVisible();
      }
      if (route === "community") {
        await expect(page.getByRole("heading", { name: "Cursor pagination" })).toBeVisible();
      }
      await page.screenshot({ path: testInfo.outputPath(`${route}-${theme}.png`) });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${route}-${theme}-phone.png`) });
      await page.setViewportSize({ width: 1280, height: 900 });
    }
  });
}
