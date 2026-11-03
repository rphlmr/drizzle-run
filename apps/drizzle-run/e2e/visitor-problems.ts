import type { BrowserContext, Dialog, Page, Request } from "@playwright/test";

type LeaveWarningAnswer = "accept" | "dismiss";

/** The leave warnings a test answers on a page, while `answerLeaveWarnings` runs. */
const leaveWarningScopes = new WeakMap<Page, { answer: LeaveWarningAnswer; dialogs: Dialog[] }>();

/**
 * Run `leave` and answer the leave warnings it raises on `page`
 *
 * A leave warning is the browser's unload prompt or the app's in-app confirm. Returns them in order; `leave` gets the
 * same list, to wait on it. Any other dialog, or one before or after `leave`, still fails the test.
 */
export async function answerLeaveWarnings(
  page: Page,
  answer: LeaveWarningAnswer,
  leave: (warnings: readonly Dialog[]) => Promise<unknown>,
): Promise<Dialog[]> {
  const scope = { answer, dialogs: [] };
  leaveWarningScopes.set(page, scope);

  try {
    await leave(scope.dialogs);
  } finally {
    leaveWarningScopes.delete(page);
  }

  return scope.dialogs;
}

/** App paths that are not pages a visitor runs projects on: API, assets, resource routes, embeds and crawler files. */
const nonPagePathPattern = /^\/(?:api|assets|runtime-assets|embed)\/|^\/(?:session|robots\.txt|sitemap\.xml)$/;

/**
 * Watch every page of a browser context for what a visitor must never meet
 *
 * Records a dialog the test did not ask for, an uncaught error of a page that is not being left, and an app page loaded
 * without cross-origin isolation, which runs need. A test that expects a leave warning answers it with
 * `answerLeaveWarnings`.
 * Call `settle` once the test is done, before reading `problems`.
 */
export function watchVisitorProblems(context: BrowserContext, appOrigin: string) {
  const problems: string[] = [];
  const isolationChecks: Promise<void>[] = [];

  const checkIsolation = async (page: Page) => {
    try {
      const document = await page.evaluate(() => ({ href: location.href, isolated: crossOriginIsolated }));
      const url = new URL(document.href);

      if (url.origin === appOrigin && !nonPagePathPattern.test(url.pathname) && !document.isolated) {
        problems.push(`${url.pathname} loaded without cross-origin isolation, so it cannot run a project`);
      }
    } catch {
      // The page navigated again or closed before it answered: its next load is checked instead.
    }
  };

  const watch = (page: Page) => {
    // WebKit reports the loads a page cancels as it is left as uncaught errors of that page, which no visitor sees.
    let leaving = false;
    const isPageNavigation = (request: Request) =>
      request.isNavigationRequest() && request.frame() === page.mainFrame();

    page.on("request", (request) => {
      if (isPageNavigation(request)) {
        leaving = true;
      }
    });
    page.on("requestfailed", (request) => {
      if (isPageNavigation(request)) {
        leaving = false;
      }
    });
    page.on("response", (response) => {
      const loadsNoPage =
        response.status() === 204 ||
        response.status() === 205 ||
        /^attachment/i.test(response.headers()["content-disposition"] ?? "");

      if (loadsNoPage && isPageNavigation(response.request())) {
        leaving = false;
      }
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        leaving = false;
      }
    });
    page.on("dialog", (dialog) => {
      const scope = leaveWarningScopes.get(page);

      if (scope !== undefined && (dialog.type() === "beforeunload" || dialog.type() === "confirm")) {
        scope.dialogs.push(dialog);
        void (scope.answer === "accept" ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
        return;
      }

      problems.push(`A ${dialog.type()} dialog the test did not expect, on ${page.url()}: ${dialog.message()}`);
      // Accepting a leave warning lets the navigation go on, as Playwright does, so the test fails on this problem only.
      const answered = dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss();
      void answered.catch(() => undefined);
    });
    page.on("pageerror", (error) => {
      if (leaving) {
        return;
      }

      problems.push(`An uncaught error on ${page.url()}: ${error.stack || error.message}`);
    });
    page.on("load", () => {
      isolationChecks.push(checkIsolation(page));
    });
  };

  for (const page of context.pages()) {
    watch(page);
  }

  context.on("page", watch);

  return {
    problems,
    settle: () => Promise.all(isolationChecks),
  };
}
