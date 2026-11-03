import { createBrowserRunner, runBrowserComparison } from "../../src/quickjs/browser.ts";
import { checkExecution } from "./execution-checks.ts";
import { checkGuestMatrix } from "./matrix-checks.ts";

const baseUrl = new URL("./", import.meta.url);

Object.assign(globalThis, {
  runQuickjsMatrix: () => checkGuestMatrix((selection) => createBrowserRunner({ selection, baseUrl })),
  runQuickjsAcceptance: () =>
    checkExecution({
      createRunner: (options) => createBrowserRunner({ ...options, baseUrl }),
      compare: (manifests, options) => runBrowserComparison(manifests, { ...options, baseUrl }),
    }),
});
