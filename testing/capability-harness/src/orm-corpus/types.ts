/** One ORM API scenario: user code that runs against the playground database and returns what it observed. */
export interface OrmCase<TDatabase> {
  /** Stable across release corpora, so coverage cannot silently diverge. */
  id: string;
  run(db: TDatabase): Promise<unknown>;
}

/** The engine-neutral outcome of one scenario, compared between native Node and the browser guest. */
export type OrmCaseResult = { id: string; ok: true; value: unknown } | { id: string; ok: false; error: unknown };
