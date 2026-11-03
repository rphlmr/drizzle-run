/** The message an actor's failure shows: an error's message, or the thrown value as text. */
export function getErrorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** `cause` as an Error: itself when it is one, else an Error with its text. */
export function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
