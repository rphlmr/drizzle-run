/** The message a failure shows: an error's message, or the thrown value as text. */
export function getErrorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
