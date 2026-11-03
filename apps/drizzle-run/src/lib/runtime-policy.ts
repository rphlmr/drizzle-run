import type { ComparisonOptions } from "@drizzle-run/orchestration";
import type { RuntimePreparation } from "@drizzle-run/runtime/browser";

/** Limits overlapping Wasm runtimes on mobile devices, independent of viewport size or orientation. */
export function getRuntimePolicy(browser: Pick<Navigator, "userAgent" | "maxTouchPoints"> | undefined): {
  preparation: RuntimePreparation;
  execution: NonNullable<ComparisonOptions["execution"]>;
} {
  if (browser === undefined) {
    return { preparation: "on_demand", execution: "sequential" };
  }

  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(browser.userAgent);
  // iPad's desktop browsing mode reports a Mac user agent but retains multitouch support.
  const touchMac = /Macintosh/i.test(browser.userAgent) && browser.maxTouchPoints > 1;

  return mobile || touchMac
    ? { preparation: "on_demand", execution: "sequential" }
    : { preparation: "eager", execution: "parallel" };
}
