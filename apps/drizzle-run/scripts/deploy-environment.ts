interface RawConfig {
  [key: string]: unknown;
  $schema?: string;
  env?: unknown;
  vars?: Record<string, unknown>;
  d1_databases?: { binding: string; database_name?: string; database_id?: string }[];
  r2_buckets?: { binding: string; bucket_name?: string }[];
  ratelimits?: { name: string; namespace_id: string; simple: { limit: number; period: number } }[];
}

/** The upcoming release's domain. */
export const nextReleaseDomain = "next.drizzle.run";

/**
 * Resolve a deploy environment's Cloudflare resources from its name
 *
 * Rate limit namespaces are account-wide, so each environment adds its own offset to production's ids and never
 * spends production's budgets. Pull request previews share theirs.
 *
 * @param name - `next` or `pr-<pull request number>`
 * @returns The environment, or null for any other name
 */
export function resolveDeployEnvironment(name: string) {
  const isNext = name === "next";

  if (!isNext && !/^pr-[1-9][0-9]*$/.test(name)) {
    return null;
  }

  // next shares the production account with other Workers, so its resources need a prefix. Pull request previews have
  // the preview account to themselves.
  const resourceName = isNext ? `drizzle-run-${name}` : name;
  const bucketPrefix = isNext ? "drizzle-run-next-" : "";

  return {
    name,
    kind: isNext ? "next" : "pull_request",
    workerName: resourceName,
    databaseName: resourceName,
    runtimeAssetsBucket: `${bucketPrefix}assets`,
    cloudProjectsBucket: `${bucketPrefix}cloud-projects`,
    rateLimitNamespaceOffset: isNext ? 1000 : 2000,
    customDomain: isNext ? nextReleaseDomain : null,
  };
}

/**
 * Derive a deploy environment's Wrangler config from the production one in wrangler.jsonc
 *
 * Keeps everything but the resources: the Worker name, the D1, the R2 buckets and the rate limit namespaces become
 * the environment's own, and the local `env` section goes. A binding this function does not know throws, so a new
 * one is never left pointing at production. `SEARCH_INDEXING: "off"` keeps search engines away
 * (worker/document-meta.ts), and workers.dev stays on beside a custom domain, where Wrangler would turn it off: the
 * release verifies there, before a new custom domain has its certificate.
 *
 * @param productionConfig - wrangler.jsonc's raw top level, as Wrangler's `experimental_readRawConfig` reads it
 * @param environment - From `resolveDeployEnvironment`
 * @param databaseId - The environment's D1 database id
 * @returns The config to write beside wrangler.jsonc, so its relative paths still hold
 */
export function toDeployWranglerConfig(
  productionConfig: RawConfig,
  environment: NonNullable<ReturnType<typeof resolveDeployEnvironment>>,
  databaseId: string,
) {
  const { $schema: _schema, env: _localEnvironments, ...production } = productionConfig;
  const buckets = new Map([
    ["RUNTIME_ASSETS", environment.runtimeAssetsBucket],
    ["CLOUD_PROJECTS", environment.cloudProjectsBucket],
  ]);

  return {
    ...production,
    name: environment.workerName,
    workers_dev: true,
    vars: { ...production.vars, SEARCH_INDEXING: "off" },
    ...(environment.customDomain === null
      ? {}
      : { routes: [{ pattern: environment.customDomain, custom_domain: true }] }),
    d1_databases: (production.d1_databases ?? []).map((database) => {
      if (database.binding !== "PLAYGROUNDS") {
        throw new Error(`Cannot give the ${environment.name} environment its own D1 for binding ${database.binding}`);
      }

      return { binding: database.binding, database_name: environment.databaseName, database_id: databaseId };
    }),
    r2_buckets: (production.r2_buckets ?? []).map((bucket) => {
      const bucketName = buckets.get(bucket.binding);

      if (bucketName === undefined) {
        throw new Error(
          `Cannot give the ${environment.name} environment its own R2 bucket for binding ${bucket.binding}`,
        );
      }

      return { ...bucket, bucket_name: bucketName };
    }),
    ratelimits: (production.ratelimits ?? []).map((rateLimit) => ({
      ...rateLimit,
      namespace_id: String(Number(rateLimit.namespace_id) + environment.rateLimitNamespaceOffset),
    })),
  };
}
