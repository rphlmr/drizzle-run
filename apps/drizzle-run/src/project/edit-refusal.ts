import { RunManifestValidationError } from "@drizzle-run/core/manifest";
import { PairManifestValidationError } from "@drizzle-run/core/pair";

import { getErrorText } from "../lib/error-text";

/**
 * The message for an editor edit the project refused
 *
 * The editor puts the file back to its saved text, so the message says so, then why: a manifest's issue messages, or
 * the error's text.
 */
export function toEditRefusalText(cause: unknown): string {
  const reason =
    cause instanceof RunManifestValidationError || cause instanceof PairManifestValidationError
      ? cause.issues.map((issue) => issue.message).join(" ")
      : getErrorText(cause);

  return `This edit was not saved, so the file is back to its saved text. ${reason}`;
}
