import type { SerializedValue, SqlEvent } from "@drizzle-run/core/contracts";

/** One distinct run-phase statement with the parameters it ran with. */
export interface PlannableStatement {
  sequences: number[];
  sql: string;
  parameters: readonly SerializedValue[];
  namedParameters?: Readonly<Record<string, SerializedValue>>;
  values: unknown[];
  namedValues?: Readonly<Record<string, unknown>>;
}

/** The statements to plan, and the ones left out with the reason shown to the user */
export interface StatementSelection {
  statements: PlannableStatement[];
  skipped: { sequences: number[]; reason: string }[];
}

/** Statements a database can plan: reads and writes, never transaction control, settings, or schema changes. */
const PLANNABLE_STATEMENT_PATTERN = /^\s*(?:\(\s*)*(?:select|insert|update|delete|with|values)\b/i;

/** The number of distinct queries of a run that get planned; later ones are skipped with a reason. */
export const MAX_PLANNED_QUERIES = 30;

const unsupported = Symbol("unsupported");

/**
 * Picks the run phase's successful statements, never schema setup or seed, and groups repeats of the
 * same SQL and parameters so each is planned once.
 */
export function selectPlannableStatements(
  events: readonly Pick<
    SqlEvent,
    "sequence" | "phase" | "kind" | "outcome" | "sql" | "parameters" | "namedParameters"
  >[],
): StatementSelection {
  const statements = new Map<string, PlannableStatement>();
  const skipped = new Map<string, { sequences: number[]; reason: string }>();
  const recordSkipped = (key: string, sequence: number, reason: string) => {
    const entry = skipped.get(key) ?? { sequences: [], reason };
    entry.sequences.push(sequence);
    skipped.set(key, entry);
  };

  for (const event of events) {
    if (
      event.phase !== "run" ||
      event.kind !== "executed" ||
      event.outcome !== "succeeded" ||
      !PLANNABLE_STATEMENT_PATTERN.test(event.sql)
    ) {
      continue;
    }

    const key = JSON.stringify([event.sql, event.parameters, event.namedParameters]);
    const known = statements.get(key);

    if (known !== undefined) {
      known.sequences.push(event.sequence);
      continue;
    }

    const values = decodeParameters(event.parameters);
    const namedEntries =
      event.namedParameters === undefined
        ? undefined
        : Object.entries(event.namedParameters).map(([name, value]) => [name, decodeParameter(value)] as const);

    if (values === undefined || namedEntries?.some(([, value]) => value === unsupported)) {
      recordSkipped(key, event.sequence, "Its parameters cannot be sent to the database again.");
      continue;
    }

    if (statements.size >= MAX_PLANNED_QUERIES) {
      recordSkipped(
        key,
        event.sequence,
        `Only the first ${MAX_PLANNED_QUERIES} distinct queries of a run are planned.`,
      );

      continue;
    }

    statements.set(key, {
      sequences: [event.sequence],
      sql: event.sql,
      parameters: event.parameters,
      values,
      ...(namedEntries === undefined
        ? {}
        : {
            namedParameters: event.namedParameters,
            namedValues: Object.fromEntries(namedEntries),
          }),
    });
  }

  return { statements: [...statements.values()], skipped: [...skipped.values()] };
}

/** Turns recorded parameters back into values a driver can bind, or undefined when one cannot be. */
export function decodeParameters(parameters: readonly SerializedValue[]): unknown[] | undefined {
  const values: unknown[] = [];

  for (const parameter of parameters) {
    const value = decodeParameter(parameter);

    if (value === unsupported) {
      return undefined;
    }

    values.push(value);
  }

  return values;
}

function decodeParameter(value: SerializedValue): unknown {
  switch (value.type) {
    case "primitive":
      return value.value;

    case "bigint":
      return BigInt(value.value);

    case "date":
      return new Date(value.value);

    case "array": {
      const entries = value.value.map(decodeParameter);

      return entries.includes(unsupported) ? unsupported : entries;
    }

    case "object": {
      const entries = Object.entries(value.value).map(([key, entry]) => [key, decodeParameter(entry)] as const);

      return entries.some(([, entry]) => entry === unsupported) ? unsupported : Object.fromEntries(entries);
    }

    case "undefined":
    case "circular":
    case "unsupported":
      return unsupported;
  }
}
