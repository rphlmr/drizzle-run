import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { runtimeAssets } from "../worker/runtime-assets.generated.ts";
import { resolveBucketTarget } from "./runtime-asset-bucket.ts";
import { parsePreviewNames } from "./runtime-asset-deployments.ts";
import { pruneRuntimeAssets } from "./runtime-asset-prune.ts";

// Deletes runtime assets that no recent deployment references. Prints the plan only, unless --delete is given.
// --keep <n> keeps the newest n deployment records (default 1). `--open-previews pr-3,pr-7` also keeps the newest
// record of each open pull request preview.

const rootDir = fileURLToPath(new URL("../../..", import.meta.url));
// The same local storage as upload-runtime-assets.ts.
const localState = resolve(rootDir, process.env.DRIZZLE_RUN_STATE_DIR ?? ".cache/cloudflare");

const { values } = parseArgs({
  options: {
    remote: { type: "boolean", default: false },
    local: { type: "boolean", default: false },
    bucket: { type: "string" },
    "account-id": { type: "string" },
    keep: { type: "string", default: "1" },
    "open-previews": { type: "string", default: "" },
    delete: { type: "boolean", default: false },
  },
});

const { bucket, storage } = resolveBucketTarget(values, localState);

if (!/^[1-9][0-9]*$/.test(values.keep)) {
  throw new Error(`Expected --keep to be a whole number of at least 1, but got ${values.keep}`);
}

await pruneRuntimeAssets({
  currentAssetKeys: runtimeAssets.map((asset) => asset.key),
  bucket,
  storage,
  keepDeployments: Number(values.keep),
  openPreviews: parsePreviewNames(values["open-previews"]),
  mode: values.delete ? "delete" : "dry_run",
  log: (line) => process.stdout.write(`${line}\n`),
});
