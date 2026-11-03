import type { Browser, Page } from "@playwright/test";

import { answerLeaveWarnings, expect, test } from "./fixtures";
import { watchVisitorProblems } from "./visitor-problems";

const siteOrigin = "https://visitor-problems.test";

/** A watched page on a fake site whose `/no-content` answers 204 and whose `/download` is a file. */
async function openWatchedPage(browser: Browser) {
  const context = await browser.newContext();
  await context.route(`${siteOrigin}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());

    if (pathname === "/no-content") {
      await route.fulfill({ status: 204 });
      return;
    }

    if (pathname === "/download") {
      await route.fulfill({ body: "file", headers: { "Content-Disposition": 'attachment; filename="file.txt"' } });
      return;
    }

    await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Page</title><p>Page</p>" });
  });
  // Another app origin, so the isolation check leaves this site's pages alone.
  const visitorProblems = watchVisitorProblems(context, "https://app.invalid");
  const page = await context.newPage();
  await page.goto(`${siteOrigin}/`);

  return { context, page, problems: visitorProblems.problems };
}

function throwLater(page: Page, message: string) {
  return page.evaluate((text) => {
    setTimeout(() => {
      throw new Error(text);
    });
  }, message);
}

for (const path of ["/no-content", "/download"]) {
  test(`should report an uncaught error after a navigation to ${path}, which loads no page`, async ({ browser }) => {
    const { context, page, problems } = await openWatchedPage(browser);

    await page.evaluate((target) => {
      location.href = target;
    }, path);

    // WebKit reports an error thrown again from the same place only once, so each throw says something new.
    let attempt = 0;
    await expect
      .poll(async () => {
        attempt += 1;
        await throwLater(page, `Thrown after the navigation, attempt ${attempt}`);
        return problems.some((problem) => problem.includes("Thrown after the navigation"));
      })
      .toBe(true);
    await context.close();
  });
}

test("should answer leave warnings inside answerLeaveWarnings only, and report a dialog after it", async ({
  browser,
}) => {
  const { context, page, problems } = await openWatchedPage(browser);
  await page.evaluate(() => addEventListener("beforeunload", (event) => event.preventDefault()));
  // Browsers only warn on leave once the visitor has used the page.
  await page.locator("p").click();

  const warnings = await answerLeaveWarnings(page, "accept", () => page.goto(`${siteOrigin}/next`));

  expect(warnings.map((warning) => warning.type())).toEqual(["beforeunload"]);
  expect(problems).toEqual([]);

  await page.evaluate(() => {
    setTimeout(() => confirm("Leave?"));
  });

  await expect
    .poll(() => problems)
    .toEqual([`A confirm dialog the test did not expect, on ${siteOrigin}/next: Leave?`]);
  await context.close();
});
