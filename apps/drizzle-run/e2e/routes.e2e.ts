import type { APIRequestContext, Page } from "@playwright/test";

import type { AppPageRoute } from "../test/app-pages";
import { projectRecord, storeProjects } from "./data";
import { appOrigin, expect, test } from "./fixtures";
import { signInWithGitHub, useGitHubAccount } from "./github";
import { postSnapshot } from "./publish";

/** What a visitor does from one page: load it, reach a project on it or through its links, and run it. */
type RouteJourney = (page: Page) => Promise<void>;

const storedProject = projectRecord(0);

/** A name no other run uses, so lists and searches in the shared e2e database find only this test's share. */
function makeUniqueName(label: string) {
  return `${label} ${crypto.randomUUID().slice(0, 8)}`;
}

/** Publishes the stored project as a share and returns its link id; `listed` also puts it in Community. */
async function publishShare(request: APIRequestContext, name: string, listed = false): Promise<string> {
  const response = await postSnapshot(request, {
    data: { snapshotVersion: 1, name, manifest: storedProject.manifest },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { id }: { id: string } = await response.json();

  if (listed) {
    const listing = await request.put(`${appOrigin}/api/playgrounds/${id}/listing`, {
      headers: { Origin: appOrigin },
      data: { topic: "playground", description: null },
    });
    expect(listing.ok(), await listing.text()).toBe(true);
  }

  return id;
}

/** Signs the page in as an account of its own, so its shares are the only ones listed for it. */
async function signInAsNewAccount(page: Page): Promise<void> {
  await useGitHubAccount(page.context(), `routes-${crypto.randomUUID().slice(0, 8)}`);
  await signInWithGitHub(page.request);
}

/** Marks the loaded document, so a later check can tell that the project opened without a reload. */
async function markLoadedDocument(page: Page): Promise<void> {
  await page.evaluate(() => Reflect.set(window, "routeJourneyDocument", true));
}

/** Runs the open project and expects it to succeed in the document `markLoadedDocument` marked. */
async function runOpenProject(page: Page): Promise<void> {
  const runButton = page.getByRole("button", { name: "Run", exact: true });

  await expect(runButton).toBeEnabled({ timeout: 120_000 });
  expect(
    await page.evaluate(() => Reflect.get(window, "routeJourneyDocument")),
    "the project opened without a reload",
  ).toBe(true);
  await runButton.click();
  await expect(page.getByRole("region", { name: "Execution output" }).getByRole("status")).toHaveText(/^Succeeded/, {
    timeout: 120_000,
  });
}

const journeys: Record<AppPageRoute, RouteJourney> = {
  "/": async (page) => {
    await page.goto("/");
    await markLoadedDocument(page);
    await page.getByRole("button", { name: "SQLite Create →" }).click();
    await expect(page).toHaveURL(/\/p\/[\w-]+/);
    await runOpenProject(page);
  },
  "/projects": async (page) => {
    await storeProjects(page, [storedProject], "/projects");
    await markLoadedDocument(page);
    await page.getByRole("link", { name: storedProject.name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/p/${storedProject.id}$`));
    await runOpenProject(page);
  },
  "/projects/shares": async (page) => {
    const name = makeUniqueName("Route share");
    await signInAsNewAccount(page);
    await publishShare(page.request, name);

    await page.goto("/projects/shares");
    await markLoadedDocument(page);
    await page.getByRole("table", { name: "My shares" }).getByRole("button", { name, exact: true }).click();
    await expect(page).toHaveURL(/\/p\//);
    await runOpenProject(page);
  },
  "/examples": async (page) => {
    await page.goto("/examples");
    await markLoadedDocument(page);
    await page
      .getByRole("list", { name: "Example list" })
      .getByRole("link")
      .filter({ hasText: "SQLite quick start" })
      .click();
    await expect(page).toHaveURL(/\/examples\/quick-start-sqlite$/);
    await runOpenProject(page);
  },
  "/examples/:slug": async (page) => {
    await page.goto("/examples/quick-start-sqlite");
    await markLoadedDocument(page);
    await runOpenProject(page);
  },
  "/community": async (page) => {
    const name = makeUniqueName("Route community share");
    await signInWithGitHub(page.request);
    const shareId = await publishShare(page.request, name, true);
    // Signed out, as a visitor: the owner of a share skips its Community notice.
    await page.context().clearCookies();

    await page.goto("/community");
    await markLoadedDocument(page);
    await page.getByRole("searchbox", { name: "Search community shares" }).fill(name);
    await page.getByRole("link", { name: `Open a copy of ${name}` }).click();
    await page
      .getByRole("dialog", { name: `Open “${name}”?` })
      .getByRole("button", { name: "Open a copy" })
      .click();
    await expect(page).toHaveURL(new RegExp(`/s/${shareId}$`));
    await runOpenProject(page);
  },
  "/p/:projectId": async (page) => {
    await storeProjects(page, [storedProject], `/p/${storedProject.id}`);
    await markLoadedDocument(page);
    await runOpenProject(page);
  },
  "/s/:snapshotId": async (page) => {
    const shareId = await publishShare(page.request, makeUniqueName("Route link"));
    // Signed out, as a visitor of the link.
    await page.context().clearCookies();

    await page.goto(`/s/${shareId}`);
    await markLoadedDocument(page);
    await runOpenProject(page);
  },
  "/*": async (page) => {
    await storeProjects(page, [storedProject], "/no-such-page");
    await markLoadedDocument(page);
    await page.getByRole("button", { name: "Back to projects" }).click();
    await page.getByRole("link", { name: storedProject.name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/p/${storedProject.id}$`));
    await runOpenProject(page);
  },
};

for (const [route, journey] of Object.entries(journeys)) {
  test(`should load ${route} from the address bar and run a project from it, in the same document`, async ({
    page,
  }) => {
    await journey(page);
  });
}
