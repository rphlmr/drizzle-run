/** XState reads setup's types only at compile time. */
export function declareType<Value>(): Value;
export function declareType(): unknown {
  return {};
}

/** Convert an actor failure to displayable text. */
export function getErrorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
