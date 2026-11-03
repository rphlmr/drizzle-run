import type { EmbedFrameErrorCode } from "../embed-loader/protocol";
import { PlaygroundNotFoundError } from "../share/playgrounds-contract";

/** The official example or guide step an embed names does not exist. */
export class EmbedTargetNotFoundError extends Error {}

/** Why an embed cannot show its playground: the code its loader gets, and the message the frame shows. */
export interface EmbedFailure {
  code: EmbedFrameErrorCode;
  message: string;
}

/**
 * Get the failure of an embed whose playground could not load
 *
 * A shared link that answers 404, or an official example or step that does not exist, is `not_found`, which the loader
 * shows without a retry. Anything else is `application_load`, which a retry may fix.
 */
export function toEmbedLoadFailure(cause: unknown): EmbedFailure {
  if (cause instanceof PlaygroundNotFoundError || cause instanceof EmbedTargetNotFoundError) {
    return { code: "not_found", message: cause.message };
  }

  return {
    code: "application_load",
    message: cause instanceof Error ? cause.message : "Drizzle Run could not initialize this playground.",
  };
}

/** Get the title the frame shows over a failure's message. */
export function getEmbedFailureTitle(failure: EmbedFailure): string {
  switch (failure.code) {
    case "not_found":
      return "This playground no longer exists";
    case "unopenable":
      return "This playground can't open here";
    case "application_load":
    case "initialization":
    case "internal":
    case "unsupported_host":
      return "Could not load this playground";
  }
}
