import { parsePlaygroundSnapshot } from "@drizzle-run/core/contracts";
import type { Page } from "@playwright/test";

import { expect, SELECT_TO_DOCUMENT_END, test } from "./fixtures";
import { signInWithGitHub, useGitHubAccount } from "./github";

async function publishFromDialog(page: Page): Promise<string> {
  const dialog = page.getByRole("dialog");

  await dialog.getByRole("checkbox", { name: /nothing private/ }).click();
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(dialog.getByText("Your snapshot is published.")).toBeVisible({ timeout: 60_000 });

  const url = await dialog.getByRole("textbox", { name: "Link", exact: true }).inputValue();
  await page.keyboard.press("Escape");

  return url;
}

async function pushFromDialog(page: Page) {
  const dialog = page.getByRole("dialog");

  await dialog.getByRole("checkbox", { name: /nothing private/ }).click();
  await dialog.getByRole("button", { name: "Push changes", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Changes pushed to the link." })).toBeVisible({
    timeout: 60_000,
  });
  await expect(dialog).toBeHidden();
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() =>
      [document.documentElement, ...Array.from(document.querySelectorAll("main, main section"))].every(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ),
  ).toBe(true);
}

test("should push changes to a shared link, which viewers get at the same address", async ({
  page,
  browser,
  request,
}) => {
  await signInWithGitHub(page.request);
  await page.goto("/");
  await page.getByRole("button", { name: /^SQLite/ }).click();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });

  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Share a public snapshot" })).toBeVisible();
  expect(await page.getByRole("dialog").evaluate((dialog) => dialog.getBoundingClientRect().width)).toBe(520);
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: /Description/ })
    .fill("Original example.");
  const firstUrl = await publishFromDialog(page);
  expect(firstUrl).toMatch(/\/s\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("button", { name: "Shared", exact: true })).toHaveText("Shared");

  const editor = page.locator(".monaco-editor .view-lines");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n// second version\n");
  await expect(editor).toContainText("second version");
  await expect(page.getByRole("button", { name: "Push changes", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Shared", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Share", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /new link/i })).toHaveCount(0);
  await dialog.getByRole("tab", { name: "Embed" }).click();
  await dialog.getByText("Show code", { exact: true }).click();
  const embedCode = dialog.locator("pre");
  await expect(embedCode).toContainText(`snapshotId: "${new URL(firstUrl).pathname.split("/").at(-1)}"`);
  await expect(embedCode).toContainText('"description": "Original example."');
  await dialog.getByRole("tab", { name: "Link" }).click();
  await expect(dialog.getByRole("note")).toContainText("Unpublished changes");
  await dialog.getByRole("button", { name: "Push changes", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Push changes" })).toBeVisible();
  await expect(dialog).toContainText("The link and its embeds show your new code to everyone.");
  await expect(dialog.getByRole("textbox", { name: /Description/ })).toHaveValue("Original example.");
  await dialog.getByRole("textbox", { name: /Description/ }).fill("Example with a comment.");
  await pushFromDialog(page);

  await expect(
    page.getByRole("contentinfo").getByRole("button", { name: "Local. Where this project is kept" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Shared", exact: true })).toHaveText("Shared");
  await expect(page.getByRole("button", { name: "Push changes", exact: true })).toHaveCount(0);

  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  await viewer.goto(firstUrl);
  await expect(viewer.locator(".monaco-editor .view-lines")).toContainText("second version", { timeout: 120_000 });
  await expect(viewer.getByRole("note").first()).toContainText("Example with a comment.");
  await viewerContext.close();

  const linkId = new URL(firstUrl).pathname.split("/").at(-1) ?? "";
  const pushed: { snapshot: unknown } = await (await page.request.get(`/api/playgrounds/${linkId}`)).json();
  const rejected = await request.put(new URL(`/api/playgrounds/${linkId}`, firstUrl).href, {
    headers: { Origin: new URL(firstUrl).origin },
    data: { snapshot: { ...(pushed.snapshot as object), name: "Intruder" }, description: null },
  });
  expect(rejected.status()).toBe(401);
  expect(JSON.stringify((await (await page.request.get(`/api/playgrounds/${linkId}`)).json()).snapshot)).toContain(
    "second version",
  );
});

test("should copy the existing shared link without pushing changes", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1440 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async (text: string) => {
        sessionStorage.setItem("copied-text", text);
      },
    });
  });
  await signInWithGitHub(page.request);
  await page.goto("/");
  await page.getByRole("button", { name: /^SQLite/ }).click();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const firstUrl = await publishFromDialog(page);

  await page.getByRole("button", { name: "Shared", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("note")).toContainText("All changes are published");
  await expect(page.getByRole("dialog").getByRole("button", { name: "Push changes", exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog").getByRole("checkbox")).toHaveCount(0);
  await page.getByRole("dialog").getByRole("tab", { name: "Embed" }).click();
  await page.getByRole("dialog").getByText("Show code", { exact: true }).click();
  const embedCode = page.getByRole("dialog").locator("pre");
  await expect(embedCode).toContainText(`snapshotId: "${new URL(firstUrl).pathname.split("/").at(-1)}"`);
  await page.getByRole("dialog").getByRole("button", { name: "Copy embed code", exact: true }).click();
  expect(await page.evaluate(() => sessionStorage.getItem("copied-text"))).toBe(await embedCode.textContent());
  await page.keyboard.press("Escape");

  const editor = page.locator(".monaco-editor .view-lines");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n// unpublished changes\n");
  let publishRequests = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;

    if (
      (request.method() === "POST" && path === "/api/playgrounds") ||
      (request.method() === "PUT" && /^\/api\/playgrounds\/[^/]+$/.test(path))
    ) {
      publishRequests += 1;
    }
  });
  await page.getByRole("button", { name: "Shared", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Link", exact: true })).toHaveValue(firstUrl);
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await expect(dialog.getByRole("note")).toContainText("Unpublished changes");
  await expect(dialog.getByRole("button", { name: "Push changes", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Push changes", exact: true }).click();
  const pushForm = page.getByRole("dialog", { name: "Push changes", exact: true });
  await pushForm.getByRole("checkbox", { name: /nothing private/ }).click();
  await pushForm.getByRole("button", { name: "Back", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Push changes", exact: true })).toBeFocused();
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText("Link copied.");
  expect(await page.evaluate(() => sessionStorage.getItem("copied-text"))).toBe(firstUrl);
  await test.info().attach("copy-existing-link", { body: await dialog.screenshot(), contentType: "image/png" });
  await expect(dialog.getByRole("button", { name: "Copy link", exact: true })).toBeVisible({ timeout: 5_000 });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole("button", { name: "Copy link", exact: true }).click();
  const urlField = dialog.getByRole("textbox", { name: "Link", exact: true });
  expect(await urlField.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
  const urlBox = await urlField.boundingBox();
  const copyBox = await dialog.getByRole("button", { name: "Copied", exact: true }).boundingBox();

  if (urlBox === null || copyBox === null) {
    throw new Error("Expected the published URL and copy action to be visible.");
  }

  expect(copyBox.y).toBeGreaterThanOrEqual(urlBox.y + urlBox.height);
  expect(copyBox.width).toBe(urlBox.width);
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
  await test.info().attach("copy-existing-link-phone", { body: await dialog.screenshot(), contentType: "image/png" });
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      value: async () => {
        throw new Error("Denied");
      },
    });
  });
  await dialog.getByRole("button", { name: "Copied", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Select the text and copy it manually.");
  await expect(dialog.getByRole("status")).toBeVisible();
  await page.keyboard.press("Escape");
  expect(publishRequests).toBe(0);
  const shared: { snapshot: unknown } = await (
    await page.request.get(`/api/playgrounds/${new URL(firstUrl).pathname.split("/").at(-1)}`)
  ).json();
  expect(JSON.stringify(shared.snapshot)).not.toContain("unpublished changes");
  await expect(editor).toContainText("unpublished changes");

  const publishedSnapshot = parsePlaygroundSnapshot(shared.snapshot);

  if (publishedSnapshot.manifest.kind !== "drizzle-run") {
    throw new Error("Expected a single-project publication.");
  }

  const publishedQuery = publishedSnapshot.manifest.files["query.ts"];

  if (publishedQuery === undefined) {
    throw new Error("Expected query.ts in the published project.");
  }

  await page.setViewportSize({ width: 1280, height: 1440 });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");

  // Firefox inserts multi-line text into Monaco twice; type each line separately.
  for (const [index, line] of publishedQuery.split("\n").entries()) {
    if (index > 0) {
      await page.keyboard.press("Enter");
    }

    if (line !== "") {
      await page.keyboard.insertText(line);
    }
  }

  await page.keyboard.press(SELECT_TO_DOCUMENT_END);
  await page.keyboard.press("Delete");
  await expect(editor).not.toContainText("unpublished changes");
  await page.getByRole("button", { name: "Shared", exact: true }).click();
  await expect(dialog.getByRole("note")).toContainText("All changes are published");
  await expect(dialog.getByRole("button", { name: "Push changes", exact: true })).toHaveCount(0);
  await test.info().attach("all-changes-published", { body: await dialog.screenshot(), contentType: "image/png" });
  await page.keyboard.press("Escape");

  await page.route(`**${new URL(firstUrl).pathname.replace("/s/", "/api/playgrounds/")}`, (route) =>
    route.fulfill({ status: 503, body: "Unavailable" }),
  );
  await page.getByRole("button", { name: "Shared", exact: true }).click();
  await expect(dialog.getByRole("note")).toContainText("Couldn't check for changes");
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Copy link", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  expect(publishRequests).toBe(0);
});

test("should copy the link and embed code without moving the dialog", async ({ page }) => {
  await signInWithGitHub(page.request);
  await page.setViewportSize({ width: 1280, height: 1440 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async (text: string) => {
        sessionStorage.setItem("copied-text", text);
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /^SQLite/ }).click();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await publishFromDialog(page);
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n// Pushed changes\n");
  await page.getByRole("button", { name: "Push changes", exact: true }).click();

  const dialog = page.getByRole("dialog");
  await pushFromDialog(page);
  await page.getByRole("button", { name: "Shared", exact: true }).click();

  for (const [tab, button, message] of [
    ["Link", "Copy link", "Link copied."],
    ["Embed", "Copy embed code", "Embed code copied."],
  ]) {
    await dialog.getByRole("tab", { name: tab }).click();
    // The panel left behind stays in view for a frame after the switch.
    await expect(dialog.getByRole("tabpanel")).toHaveCount(1);
    const expectedText =
      tab === "Link"
        ? await dialog.getByRole("textbox", { name: "Link", exact: true }).inputValue()
        : await dialog.locator("pre").textContent();
    const before = await dialog.boundingBox();
    const feedback = dialog.getByRole("status").last();
    await dialog.getByRole("button", { name: button, exact: true }).click();
    await expect(feedback).toHaveText(message);
    await expect(dialog.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("copied-text"))).toBe(expectedText);
    expect(await dialog.boundingBox()).toEqual(before);
    expect(await feedback.evaluate((element) => element.getBoundingClientRect().height)).toBe(1);

    if (button === "Copy link") {
      await test.info().attach("link-copied", { body: await dialog.screenshot(), contentType: "image/png" });
    }

    await expect(dialog.getByRole("button", { name: button, exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByRole("button", { name: "Copied", exact: true })).toHaveCount(0);
    expect(await dialog.boundingBox()).toEqual(before);
  }

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Shared", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Copy link", exact: true })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      value: async () => {
        throw new Error("Clipboard permission denied");
      },
    });
  });
  await dialog.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Select the text and copy it manually.");
  await expect(dialog.getByRole("status")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("should leave share links out of an export unless asked", async ({ page }) => {
  // An account of its own, so no Cloud project of another test joins the export.
  await useGitHubAccount(page.context(), `export-${crypto.randomUUID().slice(0, 8)}`);
  await signInWithGitHub(page.request);
  await page.goto("/");
  await page.getByRole("button", { name: /^SQLite/ }).click();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await publishFromDialog(page);

  await page.goto("/projects");
  const exportAll = async (includeLinks: boolean) => {
    await page.getByRole("button", { name: "Export all" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("The export leaves them out unless you include them.");

    if (includeLinks) {
      await dialog.getByRole("checkbox", { name: "Include share links" }).click();
      await expect(dialog).toContainText("An imported copy can push changes to them");
    }

    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Export JSON" }).click();
    const file = await (await download).path();
    const { readFile } = await import("node:fs/promises");

    return JSON.parse(await readFile(file, "utf8")) as { shareLink?: unknown }[];
  };

  const withoutLinks = await exportAll(false);
  expect(withoutLinks[0]?.shareLink).toBeUndefined();

  const withLinks = await exportAll(true);
  expect(withLinks[0]?.shareLink).toMatchObject({ linkId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  expect(withLinks[0]?.shareLink).not.toHaveProperty("editKey");
});

test("should record the last run with a share, and offer it only for a run of the shared code", async ({ page }) => {
  await signInWithGitHub(page.request);
  await page.goto("/");
  await page.getByRole("button", { name: /^SQLite/ }).click();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("region", { name: "Execution output" }).getByRole("status")).toHaveText(/^Succeeded\b/, {
    timeout: 120_000,
  });

  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("every file, environment value, and your last run's output");
  await dialog.getByRole("checkbox", { name: /nothing private/ }).click();
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(dialog.getByText("Your snapshot is published.")).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByText("Adding your run's output…")).toHaveCount(0, { timeout: 60_000 });
  await expect(dialog.getByText(/your run's output was not added/)).toHaveCount(0);
  const linkId = new URL(await dialog.getByRole("textbox", { name: "Link", exact: true }).inputValue()).pathname
    .split("/")
    .at(-1);
  await page.keyboard.press("Escape");

  const response = await page.request.get(`/api/playgrounds/${linkId}/recording`);
  expect(response.ok()).toBe(true);
  const body = await response.text();
  const { recording } = JSON.parse(body) as { recording: { result: { outcome: string; events: unknown[] } } };
  expect(recording.result.outcome).toBe("succeeded");
  expect(recording.result.events.length).toBeGreaterThan(0);
  test.info().annotations.push({ type: "recording-bytes", description: String(new TextEncoder().encode(body).length) });

  const editor = page.locator(".monaco-editor .view-lines");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n// edited after the run\n");
  await expect(editor).toContainText("edited after the run");
  await page.getByRole("button", { name: "Push changes", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Push changes" })).toBeVisible();
  await expect(dialog).toContainText("every file and environment value.");
  await expect(dialog).not.toContainText("your last run's output");
});

test("should show a missing shared link as a card with places to go, after a failed load offered Retry", async ({
  page,
}) => {
  const linkId = crypto.randomUUID();
  let status = 503;
  await page.route(`**/api/playgrounds/${linkId}`, (route) =>
    route.fulfill(
      status === 404 ? { status, json: { error: { code: "not_found" } } } : { status, body: "Unavailable" },
    ),
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/s/${linkId}`);
  await expect(page.getByRole("heading", { name: "Could not open playground" })).toBeVisible();
  await expect(page.getByRole("region", { name: "This shared playground can't be found" })).toHaveCount(0);

  status = 404;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  const card = page.getByRole("region", { name: "This shared playground can't be found" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Ask them to check the link, or to send a working Share link.");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);

  for (const [name, href] of [
    ["Browse examples", "/examples"],
    ["Community", "/community"],
    ["My projects", "/projects"],
  ] as const) {
    await expect(card.getByRole("button", { name, exact: true })).toHaveAttribute("href", href);
  }

  await expectNoHorizontalOverflow(page);
  await test.info().attach("missing-share", { body: await page.screenshot(), contentType: "image/png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card.getByRole("button", { name: "Browse examples", exact: true })).toBeInViewport();
  await expectNoHorizontalOverflow(page);
  await test.info().attach("missing-share-phone", { body: await page.screenshot(), contentType: "image/png" });

  await card.getByRole("button", { name: "Browse examples", exact: true }).click();
  await expect(page).toHaveURL(/\/examples$/);
});
