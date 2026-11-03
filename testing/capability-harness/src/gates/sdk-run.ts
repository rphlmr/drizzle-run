import assert from "node:assert/strict";

interface GateReport {
  cleanupErrors: readonly unknown[];
  events: readonly unknown[];
}

interface GateRuntime<Manifest, Report extends GateReport, QueryPlans> {
  createRun(
    manifest: Manifest,
    options: { queryPlans?: QueryPlans },
  ): { start(): void; result: Promise<Report>; cancel(): Promise<unknown> };
}

/** Bound a gate operation, releasing its deadline timer after either outcome. */
export async function waitWithin<Value>({
  work,
  timeoutMs,
  message,
}: {
  work: () => Promise<Value>;
  timeoutMs: number;
  message: string;
}): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Require bounded teardown, retaining the original failure when teardown also fails. */
export async function withCleanup<Value>({
  work,
  cleanup,
  cleanupTimeoutMs = 10_000,
}: {
  work: () => Promise<Value>;
  cleanup: () => Promise<unknown>;
  cleanupTimeoutMs?: number;
}): Promise<Value> {
  const outcome = await Promise.resolve()
    .then(work)
    .then(
      (value) => ({ ok: true, value }) as const,
      (cause: unknown) => ({ ok: false, cause }) as const,
    );

  try {
    await waitWithin({
      work: cleanup,
      timeoutMs: cleanupTimeoutMs,
      message: `Cleanup exceeded ${cleanupTimeoutMs} ms`,
    });
  } catch (cause) {
    if (!outcome.ok) {
      throw new AggregateError(
        [outcome.cause, cause],
        `${outcome.cause instanceof Error ? outcome.cause.message : String(outcome.cause)}; cleanup failed: ${String(cause)}`,
        { cause: outcome.cause },
      );
    }

    throw cause;
  }

  if (!outcome.ok) {
    throw outcome.cause;
  }

  return outcome.value;
}

/** Run through the public SDK and require cleanup before retaining the result. */
export async function runProject<Manifest, Report extends GateReport, QueryPlans = undefined>({
  runtime,
  manifest,
  queryPlans,
  timeoutMs = Number(process.env.DRIZZLE_RUN_ACCEPTANCE_TIMEOUT_MS ?? 180_000),
  cleanupTimeoutMs = 10_000,
}: {
  runtime: GateRuntime<Manifest, Report, QueryPlans>;
  manifest: Manifest;
  queryPlans?: QueryPlans;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
}): Promise<{ report: Report; events: Report["events"] }> {
  const handle = runtime.createRun(manifest, { queryPlans });

  return withCleanup({
    work: async () => {
      handle.start();
      const report = await waitWithin({
        work: () => handle.result,
        timeoutMs,
        message: `Execution exceeded ${timeoutMs} ms`,
      });
      assert.deepEqual(report.cleanupErrors, [], "Execution must release its resources");

      return { report, events: report.events };
    },
    cleanup: () => handle.cancel(),
    cleanupTimeoutMs,
  });
}
