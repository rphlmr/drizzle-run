/**
 * Declare a type for XState's `setup({ types })`
 *
 * XState reads `types` only at compile time and never reads the empty object it gets at runtime. This keeps that one
 * deliberate gap in a single place instead of an `{} as TType` assertion in every machine.
 *
 * @example
 * setup({ types: { context: declareType<RunContext>(), events: declareType<RunEvent>() } });
 */
export function declareType<TType>(): TType;
export function declareType(): unknown {
  return {};
}
