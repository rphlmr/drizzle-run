/**
 * This entrypoint is replaced by a run-specific virtual module during
 * compilation. Import it only from playground source files.
 */
function throwOutsideRun(): never {
  throw new Error("@drizzle-run/runtime/context is available only inside an active playground run");
}

export const db: never = throwOutsideRun();
export const schema: never = throwOutsideRun();
export const env: Readonly<Record<string, string>> = throwOutsideRun();
export const target: never = throwOutsideRun();
export const postgresConnection: never = throwOutsideRun();
