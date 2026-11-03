import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import * as z from "zod/mini";

import { saveRateLimitRetryAfterMs } from "./cloud-sync";
import { DEFAULT_DAILY_MESSAGES } from "./connect-quota";
import { rateLimitRetryAfterMs } from "./http";
import { defaultMaxStoredPublishBytes } from "./playgrounds";

const wranglerConfigPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

async function readWranglerConfig(environmentName?: string) {
  process.env.WRANGLER_LOG ??= "error";
  const { unstable_readConfig } = await import("wrangler");

  return unstable_readConfig({ config: wranglerConfigPath, env: environmentName });
}

async function readWranglerVars(environmentName?: string) {
  return (await readWranglerConfig(environmentName)).vars;
}

describe("wrangler.jsonc budgets", () => {
  it.each([
    { environmentName: undefined, label: "production" },
    { environmentName: "e2e", label: "e2e" },
  ])("should set each budget in $label to its code fallback", async ({ environmentName }) => {
    const vars = await readWranglerVars(environmentName);

    expect(vars).toMatchObject({
      CONNECT_DAILY_MESSAGES: String(DEFAULT_DAILY_MESSAGES),
      PUBLISH_MAX_STORED_BYTES: String(defaultMaxStoredPublishBytes),
    });
  });
});

/** The rate limit bindings as wrangler reads them, with the fields the tests check. */
const RateLimitBindingsSchema = z.array(
  z.object({ name: z.string(), namespace_id: z.string(), simple: z.object({ period: z.number() }) }),
);

async function readRateLimits(environmentName?: string) {
  return RateLimitBindingsSchema.parse((await readWranglerConfig(environmentName)).ratelimits);
}

describe("wrangler.jsonc rate limits", () => {
  const environments = [
    { environmentName: undefined, label: "production" },
    { environmentName: "e2e", label: "e2e" },
  ];

  it.each(environments)(
    "should bind each limiter in $label with the period the Worker answers",
    async ({ environmentName }) => {
      const periods = Object.fromEntries(
        (await readRateLimits(environmentName)).map((binding) => [binding.name, binding.simple.period]),
      );

      expect(periods).toEqual({
        PUBLISH_RATE_LIMIT: rateLimitRetryAfterMs / 1000,
        AUTH_RATE_LIMIT: rateLimitRetryAfterMs / 1000,
        CONNECT_RATE_LIMIT: rateLimitRetryAfterMs / 1000,
        CONNECT_ADDRESS_RATE_LIMIT: rateLimitRetryAfterMs / 1000,
        CLOUD_SYNC_RATE_LIMIT: saveRateLimitRetryAfterMs / 1000,
      });
    },
  );

  it.each(environments)("should give each limiter in $label its own namespace", async ({ environmentName }) => {
    const namespaceIds = (await readRateLimits(environmentName)).map((binding) => binding.namespace_id);

    expect(new Set(namespaceIds).size).toBe(namespaceIds.length);
  });

  it("should use the same namespace for each limiter in e2e as in production", async () => {
    const [production, e2e] = await Promise.all([readRateLimits(), readRateLimits("e2e")]);
    const toNamespaces = (bindings: typeof production) =>
      Object.fromEntries(bindings.map((binding) => [binding.name, binding.namespace_id]));

    expect(toNamespaces(e2e)).toEqual(toNamespaces(production));
  });
});
