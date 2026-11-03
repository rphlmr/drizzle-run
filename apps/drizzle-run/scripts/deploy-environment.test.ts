import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { experimental_readRawConfig } from "wrangler";

import { resolveDeployEnvironment, toDeployWranglerConfig } from "./deploy-environment.ts";

const productionConfig = experimental_readRawConfig({
  config: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
}).rawConfig;
const databaseId = "11111111-2222-4333-8444-555555555555";

describe("resolveDeployEnvironment", () => {
  it("should give each pull request its own Worker and D1, on the shared preview buckets", () => {
    expect(resolveDeployEnvironment("pr-42")).toMatchObject({
      kind: "pull_request",
      workerName: "pr-42",
      databaseName: "pr-42",
      runtimeAssetsBucket: "assets",
      cloudProjectsBucket: "cloud-projects",
      customDomain: null,
    });
  });

  it("should give next its own buckets and next.drizzle.run", () => {
    expect(resolveDeployEnvironment("next")).toMatchObject({
      kind: "next",
      workerName: "drizzle-run-next",
      runtimeAssetsBucket: "drizzle-run-next-assets",
      cloudProjectsBucket: "drizzle-run-next-cloud-projects",
      customDomain: "next.drizzle.run",
    });
  });

  it("should return null for production or any other name", () => {
    expect(["", "production", "pr-0", "pr-1a", "next-1"].map((name) => resolveDeployEnvironment(name))).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});

describe("toDeployWranglerConfig", () => {
  it("should point every production resource at the environment's own", () => {
    const environment = resolveDeployEnvironment("pr-42");

    const deployConfig = toDeployWranglerConfig(productionConfig, environment, databaseId);

    expect(deployConfig.name).toBe("pr-42");
    expect(deployConfig.env).toBeUndefined();
    expect(deployConfig.routes).toBeUndefined();
    expect(deployConfig.d1_databases).toEqual([
      { binding: "PLAYGROUNDS", database_name: "pr-42", database_id: databaseId },
    ]);
    expect(deployConfig.r2_buckets.map((bucket: { bucket_name: string }) => bucket.bucket_name)).toEqual([
      "assets",
      "cloud-projects",
    ]);
    expect(deployConfig.main).toBe(productionConfig.main);
    expect(deployConfig.durable_objects).toEqual(productionConfig.durable_objects);
  });

  it("should never share a rate limit namespace with production", () => {
    const productionNamespaces = new Set(productionConfig.ratelimits?.map((rateLimit) => rateLimit.namespace_id));

    for (const name of ["next", "pr-1"]) {
      const deployConfig = toDeployWranglerConfig(productionConfig, resolveDeployEnvironment(name), databaseId);

      for (const rateLimit of deployConfig.ratelimits) {
        expect(productionNamespaces.has(rateLimit.namespace_id)).toBe(false);
      }
    }
  });

  it("should serve next on its custom domain, and keep workers.dev for the release to verify on", () => {
    const deployConfig = toDeployWranglerConfig(productionConfig, resolveDeployEnvironment("next"), databaseId);

    expect(deployConfig.routes).toEqual([{ pattern: "next.drizzle.run", custom_domain: true }]);
    expect(deployConfig.workers_dev).toBe(true);
  });

  it("should keep production's vars and turn search indexing off", () => {
    const deployConfig = toDeployWranglerConfig(productionConfig, resolveDeployEnvironment("pr-1"), databaseId);

    expect(deployConfig.vars).toEqual({ ...productionConfig.vars, SEARCH_INDEXING: "off" });
  });

  it("should refuse a binding it cannot move off production", () => {
    const withExtraBucket = {
      ...productionConfig,
      r2_buckets: [...(productionConfig.r2_buckets ?? []), { binding: "EXPORTS", bucket_name: "drizzle-run-exports" }],
    };

    expect(() => toDeployWranglerConfig(withExtraBucket, resolveDeployEnvironment("pr-1"), databaseId)).toThrow(
      "Cannot give the pr-1 environment its own R2 bucket for binding EXPORTS",
    );
  });
});
