import { expect, test } from "./fixtures";

/** The runtime's lazy chunk, which a tab opened before a deploy still names after the deploy removed it. */
const runtimeChunkPattern = /\/assets\/browser-[^/]+\.js$/;

test("should offer a reload when a part of the app no longer loads, as in a tab opened before a deploy", async ({
  browserName,
  page,
}) => {
  // The chunk fails to load, as a file a deploy removed. A flag rather than `unroute`, which WebKit still routes the
  // reloaded page through.
  let chunkRemoved = true;
  await page.route(runtimeChunkPattern, async (route) => {
    if (chunkRemoved) {
      await route.abort();
      return;
    }

    await route.continue();
  });

  await page.goto("/examples/drizzle-in-five-minutes");
  const banner = page.getByRole("status").filter({ hasText: "Drizzle Run was updated. Reload to keep going." });
  await expect(banner).toBeVisible({ timeout: 30_000 });

  // A tab out of date has long finished starting; WebKit breaks a reload made while the page still starts.
  await page.waitForLoadState("networkidle");
  chunkRemoved = false;
  const reloaded = page.waitForEvent("load");
  await banner.getByRole("button", { name: "Reload" }).click();
  await reloaded;

  // WebKit replays the failed import for the same file name without asking the network again. After a real deploy the
  // reloaded page names new files, which this test cannot give it.
  if (browserName === "webkit") {
    return;
  }

  await expect(page.getByText("Runtime ready").first()).toBeVisible({ timeout: 120_000 });
  await expect(banner).toHaveCount(0);
});
