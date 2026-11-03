import type { APIRequestContext, BrowserContext } from "@playwright/test";
import { expect } from "@playwright/test";

import { resolveDrizzleRunPorts, toLocalOrigin } from "../../../scripts/drizzle-run-ports";

const origin = toLocalOrigin(resolveDrizzleRunPorts().app);

/** A 2x2 PNG in the accent green, served for every GitHub avatar so no test reaches avatars.githubusercontent.com. */
const avatarPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGOw7Y4BIgYIBQAfggSRonFHyAAAAABJRU5ErkJggg==",
  "base64",
);

/** Serve a fixed image for GitHub avatars, with the CORP header the app's `require-corp` documents need. */
export async function routeGitHubAvatars(context: BrowserContext): Promise<void> {
  await context.route("https://avatars.githubusercontent.com/**", (route) =>
    route.fulfill({
      contentType: "image/png",
      headers: { "Cross-Origin-Resource-Policy": "cross-origin" },
      body: avatarPng,
    }),
  );
}

/**
 * Pick the GitHub account the mock signs in as for this browser context
 *
 * The mock GitHub on the fixture port reads the cookie on its /github paths; without it, it signs in as `octocat`.
 */
export async function useGitHubAccount(context: BrowserContext, login: string): Promise<void> {
  await context.addCookies([{ name: "e2e-github-user", value: login, domain: "127.0.0.1", path: "/github" }]);
}

/**
 * Sign in through the real routes and the mock GitHub, without a page
 *
 * Use `page.request` to sign the page's browser context in (it shares the cookies), or the `request` fixture for API
 * calls. Pages opened afterwards read the session when they load.
 */
export async function signInWithGitHub(request: APIRequestContext): Promise<void> {
  const response = await request.get(`${origin}/api/auth/github/login?returnTo=/`);
  expect(response.ok(), `Sign-in ended on ${response.url()} with HTTP ${response.status()}`).toBe(true);

  const session = await request.get(`${origin}/api/auth/session`);
  expect(((await session.json()) as { user: unknown }).user).not.toBeNull();
}

/** Sign `request` in as the mock's account, unless it already has a session. */
export async function ensureSignedInWithGitHub(request: APIRequestContext): Promise<void> {
  const session = await request.get(`${origin}/api/auth/session`);

  if (session.ok() && ((await session.json()) as { user: unknown }).user !== null) {
    return;
  }

  await signInWithGitHub(request);
}
