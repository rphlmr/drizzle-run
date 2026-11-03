import { assertParsedAsWritten } from "../shared/define.ts";
import type { PairManifest } from "./types.ts";
import { parsePairManifest } from "./validation.ts";

/**
 * Define a side-by-side manifest in source
 *
 * Checks the manifest when the module loads and throws a `PairManifestValidationError` when it is invalid, such as a
 * side on an older Legacy fix release. Also throws when parsing would change it, so the manifest returned is the one
 * that runs.
 */
export function definePairManifest<const Manifest extends PairManifest>(manifest: Manifest): Manifest {
  assertParsedAsWritten(manifest, parsePairManifest(manifest), "side-by-side");

  return manifest;
}
