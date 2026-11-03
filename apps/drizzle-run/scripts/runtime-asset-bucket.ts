import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { R2Bucket } from "@cloudflare/workers-types";
import { getPlatformProxy } from "wrangler";

/** The local store or remote account that owns a runtime asset bucket. */
export type BucketStorage = { kind: "local"; stateDir: string } | { kind: "remote"; accountId: string };

/** A runtime asset bucket and the storage used to reach it. */
export interface BucketTarget {
  bucket: string;
  storage: BucketStorage;
}

const require = createRequire(import.meta.url);
const wranglerPackage = require.resolve("wrangler/package.json");
const wrangler = resolve(dirname(wranglerPackage), require(wranglerPackage).bin.wrangler);

// Must match the bucket wrangler.jsonc binds to RUNTIME_ASSETS.
export const localRuntimeAssetBucket = "drizzle-run-assets";

/**
 * Reads the bucket target from parsed `--local`, `--remote`, `--bucket` and `--account-id` arguments
 *
 * @param values - The parsed arguments
 * @param localStateDir - Wrangler's local storage folder, used with `--local`
 * @returns The bucket name and its storage
 */
export function resolveBucketTarget(
  values: {
    remote: boolean;
    local: boolean;
    bucket?: string;
    "account-id"?: string;
  },
  localStateDir: string,
): BucketTarget {
  if (values.remote === values.local || (values.remote && (!values.bucket || !values["account-id"]))) {
    throw new Error(
      "Choose --local, or explicitly choose --remote --bucket <existing-production-bucket> --account-id <account-id>.",
    );
  }

  if (values["account-id"] !== undefined && !/^[a-f0-9]{32}$/.test(values["account-id"])) {
    throw new Error("The Cloudflare account ID is invalid.");
  }

  if (values.bucket !== undefined && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(values.bucket)) {
    throw new Error("The R2 bucket name is invalid.");
  }

  if (values.remote && values["account-id"] !== undefined) {
    return {
      bucket: values.bucket ?? localRuntimeAssetBucket,
      storage: { kind: "remote", accountId: values["account-id"] },
    };
  }

  return {
    bucket: values.bucket ?? localRuntimeAssetBucket,
    storage: { kind: "local", stateDir: localStateDir },
  };
}

/**
 * Runs one `wrangler r2 object` command quietly, and prints its output only when it fails.
 *
 * @param options.command - `put` or `delete`
 * @param options.objectPath - `<bucket>/<key>`
 * @param options.args - The command's own arguments, such as `--file`
 * @param options.storage - The bucket's storage
 */
export function runR2ObjectCommand({
  command,
  objectPath,
  args = [],
  storage,
}: {
  command: "put" | "delete";
  objectPath: string;
  args?: string[];
  storage: BucketStorage;
}) {
  const target = storage.kind === "remote" ? ["--remote"] : ["--local", "--persist-to", storage.stateDir];
  const childEnvironment = {
    ...process.env,
    CLOUDFLARE_SEND_METRICS: "false",
    ...(storage.kind === "remote" ? { CLOUDFLARE_ACCOUNT_ID: storage.accountId } : {}),
  };

  return new Promise<void>((resolveProcess, reject) => {
    const child = spawn(process.execPath, [wrangler, "r2", "object", command, objectPath, ...args, ...target], {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnvironment,
    });
    const output: Buffer[] = [];

    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveProcess();
        return;
      }

      process.stderr.write(Buffer.concat(output));
      reject(new Error(`wrangler r2 object ${command} ${objectPath} exited with ${signal ?? `code ${code}`}`));
    });
  });
}

/**
 * Opens an R2 binding on the bucket, runs `read` with it, and closes it
 *
 * @param options.bucket - The R2 bucket name
 * @param options.storage - The bucket's storage
 * @param read - Receives the `R2Bucket` binding
 * @returns What `read` returns
 */
export async function withBucketBinding<TResult>(
  { bucket, storage }: BucketTarget,
  read: (bucketBinding: R2Bucket) => Promise<TResult>,
): Promise<TResult> {
  const configDir = await mkdtemp(join(tmpdir(), "drizzle-run-r2-"));

  try {
    const configPath = join(configDir, "wrangler.json");

    await writeFile(
      configPath,
      JSON.stringify({
        name: "drizzle-run-runtime-assets",
        compatibility_date: "2026-10-11",
        send_metrics: false,
        ...(storage.kind === "remote" ? { account_id: storage.accountId } : {}),
        r2_buckets: [{ binding: "BUCKET", bucket_name: bucket, remote: storage.kind === "remote" }],
      }),
    );

    const proxy = await getPlatformProxy<{ BUCKET: R2Bucket }>({
      configPath,
      envFiles: [],
      persist: storage.kind === "remote" ? false : { path: join(storage.stateDir, "v3") },
    });

    try {
      return await read(proxy.env.BUCKET);
    } finally {
      await proxy.dispose();
    }
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}
