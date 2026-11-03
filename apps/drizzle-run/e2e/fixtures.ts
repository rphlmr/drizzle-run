import { expect, test as base } from "@playwright/test";

import { resolveDrizzleRunPorts, toLocalOrigin } from "../../../scripts/drizzle-run-ports";
import { PROJECT_INTRO_SETTING, type ProjectIntroState } from "../src/workspace/project-arrival";
import { routeGitHubAvatars } from "./github";
import { callStoreInOneWorker, type StoreCall } from "./store";
import { watchVisitorProblems } from "./visitor-problems";

export { expect };
export { answerLeaveWarnings } from "./visitor-problems";

const ports = resolveDrizzleRunPorts();

/** Origin of the Drizzle Run app under test, the same as Playwright's `baseURL`. */
export const appOrigin = toLocalOrigin(ports.app);

/** Origin of the blog fixture, the third-party page that embeds the app. */
export const blogOrigin = toLocalOrigin(ports.fixture);

/** Monaco's "select to the end of the file": Cmd+Shift+Down on macOS, Ctrl+Shift+End elsewhere. */
export const SELECT_TO_DOCUMENT_END = process.platform === "darwin" ? "Meta+Shift+ArrowDown" : "Control+Shift+End";

/**
 * Every page starts with the first-run guide marked as seen, so the guide never covers what a test clicks.
 * Onboarding tests opt out with `test.use({ guideSeen: false })`. GitHub avatars are served locally.
 *
 * The intro "Your project lives in this browser" starts muted, so it never covers a new project. Intro tests set it
 * with `test.use({ projectIntro: "unseen" })`.
 *
 * Every test fails on what a visitor must never meet (`watchVisitorProblems`): a dialog it did not expect, an uncaught
 * page error, or an app page that cannot run a project.
 */
export const test = base.extend<{ guideSeen: boolean; projectIntro: ProjectIntroState }>({
  guideSeen: [true, { option: true }],
  projectIntro: ["muted", { option: true }],
  context: async ({ context, baseURL, guideSeen, projectIntro }, use) => {
    await routeGitHubAvatars(context);

    const settings: StoreCall[] = [
      ...(guideSeen ? [["writeSetting", "guide-seen", true] satisfies StoreCall] : []),
      ...(projectIntro === "unseen" ? [] : [["writeSetting", PROJECT_INTRO_SETTING, projectIntro] satisfies StoreCall]),
    ];

    if (settings.length > 0) {
      const setup = await context.newPage();
      await callStoreInOneWorker(setup, settings);
      await setup.close();
    }

    // The deployed run's baseURL is the deployed Worker, which is the app under test there.
    const visitorProblems = watchVisitorProblems(context, new URL(baseURL ?? appOrigin).origin);
    await use(context);

    await visitorProblems.settle();
    expect(visitorProblems.problems, "What a visitor met during the test").toEqual([]);
  },
});
