import type { Browser, BrowserContext, Page } from "@playwright/test";

import { resolveDrizzleRunPorts, toLocalOrigin } from "../../../scripts/drizzle-run-ports";
import { projectRecord, storeProjects } from "./data";
import { expect, test } from "./fixtures";
import { routeGitHubAvatars, signInWithGitHub, useGitHubAccount } from "./github";
import { callStoreInOneWorker } from "./store";

const origin = toLocalOrigin(resolveDrizzleRunPorts().app);

/** An account no other test signs in as, so its links and sessions are this test's alone. */
function makeUniqueLogin(label: string) {
  return `${label}-${crypto.randomUUID().slice(0, 8)}`;
}

function getAccountButton(page: Page) {
  return page.getByRole("banner").getByRole("button", { name: /^Account/ });
}

async function readSessionUser(page: Page): Promise<unknown> {
  const response = await page.request.get(`${origin}/api/auth/session`);
  return ((await response.json()) as { user: unknown }).user;
}

/** A second browser, as on another machine: its own cookies and local store, with the guide seen. */
async function openAnotherBrowser(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: origin });
  await routeGitHubAvatars(context);
  const setup = await context.newPage();
  await callStoreInOneWorker(setup, [
    ["writeSetting", "guide-seen", true],
    ["writeSetting", "project-intro", "muted"],
  ]);
  await setup.close();

  return context;
}

async function openProject(page: Page, name: string): Promise<void> {
  const project = { ...projectRecord(0), id: crypto.randomUUID(), name };
  await storeProjects(page, [project], `/p/${project.id}`);
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
}

test("should sign in from the account menu, come back to the same page, and sign out", async ({ page }) => {
  await page.goto("/community?topic=bug-repros");
  await getAccountButton(page).click();
  const menu = page.getByRole("menu");
  await expect(menu).toContainText("Not signed in");
  await expect(menu).toContainText(
    "An account lets you share links, list them in Community, and keep projects in Cloud across machines. Everything else works without one.",
  );

  await menu.getByRole("menuitem", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL(`${origin}/community?topic=bug-repros`);
  await expect(getAccountButton(page)).toHaveAccessibleName("Account: signed in as @octocat");

  const cookies = await page.context().cookies(origin);
  expect(cookies.find((cookie) => cookie.name === "drizzle-run-session")).toMatchObject({
    httpOnly: true,
    sameSite: "Lax",
  });
  expect(await page.evaluate(() => document.cookie)).not.toContain("drizzle-run-session");
  expect(JSON.stringify(await readSessionUser(page))).not.toContain("gho_");

  await getAccountButton(page).click();
  await expect(menu).toContainText("Signed in as @octocat");
  await menu.getByRole("menuitem", { name: "Sign out" }).click();
  // A sign-out before cloud sync started has no Cloud project to take out, so it does not ask.
  const confirm = page.getByRole("dialog", { name: "Sign out?" });
  await expect(
    confirm.or(page.getByRole("banner").getByRole("button", { name: "Account", exact: true })),
  ).toBeVisible();

  if (await confirm.isVisible()) {
    await confirm.getByRole("button", { name: "Sign out" }).click();
  }

  await expect(getAccountButton(page)).toHaveAccessibleName("Account");
  expect(await readSessionUser(page)).toBeNull();
});

test("should refuse a callback that was not started in this browser", async ({ page }) => {
  await page.goto(`/api/auth/github/callback?code=forged&state=${"f".repeat(43)}`);

  await expect(page.getByRole("heading", { name: "Sign-in failed" })).toBeVisible();
  expect(await readSessionUser(page)).toBeNull();
});

test("should recheck the session when an open page becomes active after an hour", async ({ page }) => {
  await signInWithGitHub(page.request);
  const now = new Date();
  await page.clock.install({ time: now });
  await page.goto("/community");
  await expect(getAccountButton(page)).toHaveAccessibleName("Account: signed in as @octocat");

  await page.clock.setSystemTime(new Date(now.getTime() + 60 * 60 * 1000 + 1_000));
  const checked = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/session");
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" })));

  expect((await checked).ok()).toBe(true);
  await expect(getAccountButton(page)).toHaveAccessibleName("Account: signed in as @octocat");
});

test("should refuse a cross-site sign-out and keep the session", async ({ page }) => {
  await signInWithGitHub(page.request);

  const response = await page.request.post(`${origin}/api/auth/logout`, {
    headers: { Origin: "https://evil.test", "Sec-Fetch-Site": "cross-site" },
  });

  expect(response.status()).toBe(403);
  expect(await readSessionUser(page)).not.toBeNull();
});

test("should ask to sign in before sharing, and share once signed in", async ({ page }) => {
  const name = `Sign in to share ${crypto.randomUUID().slice(0, 8)}`;
  await openProject(page, name);

  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Sign in to share" })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: /secrets/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Sign in with GitHub" }).click();

  await expect(page).toHaveURL(/\/p\/[0-9a-f-]+$/);
  await expect(getAccountButton(page)).toHaveAccessibleName("Account: signed in as @octocat");
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
  await page.getByRole("button", { name: "Share", exact: true }).click();
  // A first share starts in Community: one click publishes and lists it.
  await expect(dialog.getByRole("radio", { name: "Community" })).toBeChecked();
  await dialog.getByRole("checkbox", { name: /secrets/ }).click();
  await dialog.getByRole("button", { name: "Publish to Community", exact: true }).click();
  await expect(dialog.getByText("Published to Community.")).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByRole("radio", { name: "Community" })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "In Community", exact: true })).toBeVisible();

  await page.goto("/projects/shares");
  await expect(page.getByRole("table", { name: "My shares" }).getByRole("row").filter({ hasText: name })).toContainText(
    "In Community",
  );
});

test("should push changes to an owned link from another browser, and only for its owner", async ({ page, browser }) => {
  const owner = makeUniqueLogin("owner");
  await useGitHubAccount(page.context(), owner);
  await signInWithGitHub(page.request);
  await openProject(page, `Owned link ${crypto.randomUUID().slice(0, 8)}`);

  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await dialog.getByRole("radio", { name: "Link only" }).click();
  await dialog.getByRole("checkbox", { name: /secrets/ }).click();
  await dialog.getByRole("button", { name: "Create link", exact: true }).click();
  await expect(dialog.getByText("Your link is ready.")).toBeVisible({ timeout: 60_000 });
  const linkPath = new URL(await dialog.getByRole("textbox", { name: "Link", exact: true }).inputValue()).pathname;

  const laptop = await openAnotherBrowser(browser);
  await useGitHubAccount(laptop, owner);
  const laptopPage = await laptop.newPage();
  await signInWithGitHub(laptopPage.request);
  await laptopPage.goto(linkPath);
  await laptopPage.getByRole("button", { name: "Fork to my projects" }).click();
  await expect(laptopPage).toHaveURL(/\/p\/[0-9a-f-]+$/);
  await expect(laptopPage.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
  await laptopPage.locator(".monaco-editor .view-lines").click();
  await laptopPage.keyboard.press("ControlOrMeta+End");
  await laptopPage.keyboard.insertText("\n// Pushed from another browser\n");
  const laptopDialog = laptopPage.getByRole("dialog");
  await laptopPage.getByRole("button", { name: "Shared", exact: true }).click();
  await expect(laptopDialog.getByRole("heading", { name: "Share", exact: true })).toBeVisible();
  await laptopDialog.getByRole("button", { name: "Update share", exact: true }).click();
  await laptopDialog.getByRole("checkbox", { name: /nothing private/ }).click();
  await laptopDialog.getByRole("button", { name: "Update share", exact: true }).click();
  await expect(laptopPage.getByRole("status").filter({ hasText: "Share updated." })).toBeVisible({
    timeout: 60_000,
  });
  await expect(laptopDialog).toBeHidden();
  await laptop.close();

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Shared", exact: true }).click();
  await expect(dialog.getByRole("note")).toContainText("You edited the project since you shared it");
  await page.keyboard.press("Escape");

  const stranger = await openAnotherBrowser(browser);
  await useGitHubAccount(stranger, makeUniqueLogin("stranger"));
  const strangerPage = await stranger.newPage();
  await signInWithGitHub(strangerPage.request);
  await strangerPage.goto(linkPath);
  await strangerPage.getByRole("button", { name: "Fork to my projects" }).click();
  await expect(strangerPage.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
  await strangerPage.getByRole("button", { name: "Share", exact: true }).click();
  await expect(strangerPage.getByRole("dialog").getByRole("heading", { name: /^Share / })).toBeVisible();
  await stranger.close();
});
