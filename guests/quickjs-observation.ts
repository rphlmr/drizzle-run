import type { LogEvent, SqlEvent } from "../packages/core/src/contracts/result.ts";
import { serializeError, serializeValue } from "../packages/core/src/contracts/serialization.ts";
import type { RuntimeWorkerMessage } from "../packages/runtime/src/browser/protocol.ts";
import { observePostgresWire, readUndecodedTypeOid } from "../packages/runtime/src/quickjs/wire-observer.ts";
import type { WireTransaction } from "../packages/runtime/src/transactions/transactions.ts";

type GuestEvent = Extract<RuntimeWorkerMessage, { kind: "event" }>;
type GuestPhase = "schema" | "bootstrap" | "seed" | "run" | "inspect";
type TransactionRecord = Omit<WireTransaction, "outcome" | "durationMs"> & {
  statements: number[];
  startedAt: number;
  outcome?: WireTransaction["outcome"];
  durationMs?: number;
};

declare function hostRuntimeEvent(message: string): void;

function serializeParameters(parameters: unknown): Pick<SqlEvent, "parameters" | "namedParameters"> {
  if (Array.isArray(parameters)) {
    return { parameters: parameters.map(serializeValue) };
  }

  if (parameters !== null && typeof parameters === "object") {
    return {
      parameters: [],
      namedParameters: Object.fromEntries(
        Object.entries(parameters).map(([key, value]) => [key, serializeValue(value)]),
      ),
    };
  }

  return { parameters: [] };
}

function callSite(error: unknown = new Error()) {
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  const frames = [...stack.matchAll(/drizzle-run-bundle\.js:(\d+):(\d+)/g)]
    .slice(0, 8)
    .map((frame) => `${frame[1]}:${frame[2]}`)
    .join(" ");

  return frames ? { frames } : {};
}

function property(value: unknown, name: PropertyKey): unknown {
  return value !== null && typeof value === "object" ? Reflect.get(value, name) : undefined;
}

/** Observe at the guest boundary so values and call sites still belong to the project's realm. */
export function createRunObservation() {
  let phase: GuestPhase = "schema";
  let sqlSequence = 0;
  let logSequence = 0;
  let eventCount = 0;
  let transactionOwnership: "known" | "ambiguous" = "known";
  const transactions: TransactionRecord[] = [];
  const openTransactions: TransactionRecord[] = [];
  let access: { frames?: string; phase: GuestPhase; status: "unused" | "used" | "ambiguous" } = {
    phase,
    status: "used",
  };

  function emit(event: GuestEvent) {
    eventCount += 1;

    if (eventCount > 4_000) {
      throw new RangeError("The run sent more than 4000 logs, queries and events");
    }

    hostRuntimeEvent(JSON.stringify(event));
  }

  function setPhase(value: GuestPhase) {
    phase = value;
  }

  function log(level: LogEvent["level"], values: unknown[]) {
    emit({
      kind: "event",
      type: "log",
      payload: {
        sequence: ++logSequence,
        phase: phase === "bootstrap" || phase === "inspect" ? "schema" : phase,
        level,
        values: values.map(serializeValue),
        ...callSite(),
      },
    });
  }

  function display(label: string, values: unknown[]) {
    emit({ kind: "event", type: "display", payload: { label, values: values.map(serializeValue), ...callSite() } });
  }

  function generated(sql: string) {
    emit({
      kind: "event",
      type: "sql",
      payload: {
        sequence: ++sqlSequence,
        phase: "bootstrap",
        origin: "kit",
        kind: "generated",
        sql,
        parameters: [],
        outcome: "succeeded",
      },
    });
  }

  function startStatement() {
    const sequence = ++sqlSequence;
    openTransactions.at(-1)?.statements.push(sequence);

    return sequence;
  }

  function statementSite() {
    const site =
      access.phase === phase && access.status !== "ambiguous" && access.frames ? { frames: access.frames } : {};
    access = { ...access, status: "used" };

    return site;
  }

  async function statement(sql: string, parameters: unknown, execute: () => unknown) {
    const startedAt = performance.now();
    const sequence = startStatement();
    const site = statementSite();
    const input: Omit<SqlEvent, "outcome"> = {
      sequence,
      phase: phase === "schema" ? "bootstrap" : phase,
      origin: phase === "bootstrap" ? "adapter" : "drizzle",
      kind: "executed",
      sql,
      ...serializeParameters(parameters),
    };

    try {
      const value: unknown = await execute();
      const results: unknown[] = Array.isArray(value) ? value : [value];
      const commandTags = results
        .map((result) => property(result, "command"))
        .filter((command): command is string => typeof command === "string" && /^[A-Z]{1,32}$/.test(command));
      const counts = results
        .map((result) => property(result, "rowCount"))
        .filter((count): count is number => typeof count === "number" && Number.isSafeInteger(count) && count >= 0);
      const columns = property(value, "columns");
      const rows = property(value, "rows");
      const affected = property(value, "rowsAffected");
      const rowCount = counts.length
        ? counts.reduce((total, count) => total + count, 0)
        : Array.isArray(columns) && columns.length && Array.isArray(rows)
          ? rows.length
          : /^\s*(?:with\b[\s\S]*?\b)?(?:insert|update|delete|replace)\b/i.test(sql) && typeof affected === "number"
            ? affected
            : undefined;
      emit({
        kind: "event",
        type: "sql",
        payload: {
          ...input,
          ...site,
          durationMs: performance.now() - startedAt,
          outcome: "succeeded",
          ...(rowCount === undefined ? {} : { rowCount }),
          ...(commandTags.length ? { commandTags } : {}),
        },
      });

      return value;
    } catch (cause) {
      emit({
        kind: "event",
        type: "sql",
        payload: {
          ...input,
          ...site,
          durationMs: performance.now() - startedAt,
          outcome: "failed",
          error: serializeError(cause),
        },
      });
      throw cause;
    }
  }

  function observeClient<Client extends object>(client: Client, dialect: "postgresql" | "sqlite"): Client {
    return new Proxy(client, {
      get(target, key) {
        const method: unknown = Reflect.get(target, key, target);

        if (typeof method !== "function") {
          return method;
        }

        if (key === "query" || key === "execute") {
          return (input: unknown, ...args: unknown[]) => {
            const sql = typeof input === "string" ? input : (property(input, "sql") ?? property(input, "text"));
            const parameters =
              typeof input === "string" ? args[0] : (property(input, "args") ?? property(input, "values") ?? args[0]);

            if (typeof sql !== "string") {
              throw new TypeError("A database statement requires SQL text");
            }

            return statement(sql, parameters ?? [], () => Reflect.apply(method, target, [input, ...args]));
          };
        }

        if (dialect === "sqlite" && key === "transaction") {
          return async (...args: unknown[]) => {
            const transaction = await statement(
              args[0] === undefined || args[0] === "write" ? "BEGIN IMMEDIATE" : "BEGIN DEFERRED",
              [],
              () => Reflect.apply(method, target, args),
            );

            if (!transaction || typeof transaction !== "object") {
              throw new TypeError("The SQLite client returned no transaction");
            }

            return observeClient(transaction, dialect);
          };
        }

        if (dialect === "sqlite" && (key === "commit" || key === "rollback")) {
          return () => statement(key.toUpperCase(), [], () => Reflect.apply(method, target, []));
        }

        if (dialect === "sqlite" && (key === "batch" || key === "migrate")) {
          return async (input: unknown[], ...args: unknown[]) => {
            const statements = input.map((item) => {
              const sql = typeof item === "string" ? item : Array.isArray(item) ? item[0] : property(item, "sql");
              const parameters: unknown = Array.isArray(item) ? item[1] : property(item, "args");

              if (typeof sql !== "string") {
                throw new TypeError("A batch statement requires SQL text");
              }

              return { sql, parameters };
            });
            let error: ReturnType<typeof serializeError> | undefined;

            try {
              return await Reflect.apply(method, target, [input, ...args]);
            } catch (cause) {
              error = serializeError(cause);
              throw cause;
            } finally {
              for (const { sql, parameters } of statements) {
                emit({
                  kind: "event",
                  type: "sql",
                  payload: {
                    sequence: startStatement(),
                    phase: phase === "schema" ? "bootstrap" : phase,
                    origin: phase === "bootstrap" ? "adapter" : "drizzle",
                    kind: "executed",
                    sql,
                    ...serializeParameters(parameters),
                    ...statementSite(),
                    outcome: error ? "failed" : "succeeded",
                    ...(error ? { error } : {}),
                  },
                });
              }
            }
          };
        }

        return (...args: unknown[]) => Reflect.apply(method, target, args);
      },
    });
  }

  function observeDatabase<Database extends object>(database: Database, owner?: number): Database {
    return new Proxy(database, {
      get(target, key) {
        const method: unknown = Reflect.get(target, key, target);
        const site = callSite();

        if (site.frames) {
          access = {
            ...site,
            phase,
            status:
              access.status !== "used" && access.phase === phase && access.frames !== site.frames
                ? "ambiguous"
                : "unused",
          };
        }

        if (typeof method !== "function") {
          return method;
        }

        if (key !== "transaction" || (phase !== "run" && phase !== "seed")) {
          return (...args: unknown[]) => Reflect.apply(method, target, args);
        }

        return async (callback: unknown, ...rest: unknown[]) => {
          if (typeof callback !== "function") {
            throw new TypeError("A transaction requires a callback");
          }

          if (openTransactions.at(-1)?.id !== owner || transactions.length >= 200) {
            transactionOwnership = "ambiguous";
          }

          const record: TransactionRecord = {
            id: transactions.length + 1,
            ...(owner === undefined ? {} : { parent: owner }),
            phase: phase === "seed" ? "seed" : "run",
            ...callSite(),
            statements: [],
            startedAt: performance.now(),
          };
          transactions.push(record);
          openTransactions.push(record);
          let thrown: unknown;

          try {
            const value: unknown = await Reflect.apply(method, target, [
              async (tx: object) => {
                try {
                  return await Reflect.apply(callback, undefined, [observeDatabase(tx, record.id)]);
                } catch (cause) {
                  thrown = cause;
                  throw cause;
                }
              },
              ...rest,
            ]);
            record.outcome = "committed";

            return value;
          } catch (cause) {
            record.outcome = "rolled_back";
            const error = thrown ?? cause;
            const { name, message } = serializeError(error);
            record.reason = name === "TransactionRollbackError" ? "rollback_call" : "error";
            record.error = { name, message, ...callSite(error) };
            throw cause;
          } finally {
            const index = openTransactions.indexOf(record);

            if (index !== openTransactions.length - 1) {
              transactionOwnership = "ambiguous";
            }

            openTransactions.splice(index, 1);
            record.durationMs = performance.now() - record.startedAt;
          }
        };
      },
    });
  }

  function reportTransactions(): WireTransaction[] | undefined {
    if (transactionOwnership === "ambiguous" || transactions.length === 0) {
      return undefined;
    }

    return transactions.flatMap(({ startedAt: _startedAt, outcome, durationMs, ...record }) =>
      outcome === undefined || durationMs === undefined ? [] : [{ ...record, outcome, durationMs }],
    );
  }

  function connectionObserver() {
    return observePostgresWire({
      onStart: startStatement,
      onStatement(wireStatement, outcome, cause) {
        const commandTags = wireStatement.tags
          .map((tag) => tag.split(" ")[0])
          .filter((tag) => /^[A-Z]{1,32}$/.test(tag));
        const counts = wireStatement.tags.flatMap((tag) => {
          const count = /^(?:INSERT \d+|SELECT|UPDATE|DELETE|MERGE|COPY|FETCH|MOVE) (\d+)$/.exec(tag)?.[1];

          return count === undefined ? [] : [Number(count)];
        });
        emit({
          kind: "event",
          type: "sql",
          payload: {
            sequence: wireStatement.sequence,
            phase: phase === "schema" ? "bootstrap" : phase,
            origin: "drizzle",
            kind: "executed",
            sql: wireStatement.sql,
            parameters: wireStatement.parameters.map((parameter) => {
              const typeOid = readUndecodedTypeOid(parameter);

              return typeOid === undefined
                ? serializeValue(parameter)
                : {
                    type: "unsupported",
                    valueType: "binary",
                    description: `Binary PostgreSQL parameter of type OID ${typeOid}`,
                  };
            }),
            durationMs: performance.now() - wireStatement.started,
            outcome,
            ...(outcome === "failed" ? { error: serializeError(cause) } : {}),
            ...(outcome === "succeeded" && counts.length
              ? { rowCount: counts.reduce((total, count) => total + count, 0) }
              : {}),
            ...(commandTags.length ? { commandTags } : {}),
          },
        });
      },
      onError(cause) {
        emit({
          kind: "event",
          type: "diagnostic",
          payload: {
            severity: "warning",
            code: "PG_CONNECTION_UNOBSERVED",
            message: `SQL observation stopped on a PostgreSQL connection: ${serializeError(cause).message}`,
          },
        });
      },
    });
  }

  return {
    setPhase,
    log,
    display,
    generated,
    observeClient,
    observeDatabase,
    reportTransactions,
    serializeValue,
    connectionObserver,
  };
}
