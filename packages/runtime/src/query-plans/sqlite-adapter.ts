import { serializeError, type QueryPlanSize, type RawQueryPlan, type SqliteRawPlan } from "@drizzle-run/core/contracts";
import { median } from "es-toolkit";
import * as z from "zod/mini";

import { getErrorText } from "../machines/error-text.ts";
import { PlainRecordSchema } from "../schema.ts";
import {
  isWrite,
  numberValue,
  queryRows,
  sqlLiteral,
  stringValue,
  type DialectAdapter,
  type FillTable,
  type PlanningDatabase,
} from "./adapter.ts";
import type { PlanTable } from "./schema.ts";
import { quoteIdentifier } from "./sql-text.ts";
import { readSqlitePlan, sqliteUsesIndex } from "./sqlite-reading.ts";

/** What `plan.time` returns: the time of each sample, in milliseconds. */
const TimingResultSchema = z.pipe(PlainRecordSchema, z.object({ samples: z.array(z.unknown()) }));

interface SqliteColumn {
  name: string;
  affinity: "integer" | "text" | "real" | "blob" | "numeric";
  notNull: boolean;
  hasDefault: boolean;
  generated: boolean;
  /** The INTEGER PRIMARY KEY of a rowid table: SQLite numbers it. */
  rowid: boolean;
}

interface SqliteFill {
  columns: SqliteColumn[];
  uniqueColumns: Set<string>;
  radixKeys: Set<number>;
  bases: Map<string, number>;
  generated: number;
}

type IntrospectedTable = FillTable & {
  columns: string[];
  indexes: { name: string; columns: string[] }[];
  foreignKeys: { columns: string[]; referencedTable: string; referencedColumns: string[] }[];
  parents: number[];
};

/** Time spent on each timed query per size; one slow run is enough when a single run takes longer. */
const TIMING_BUDGET_MS = 200;
const TIMING_MAX_SAMPLES = 25;

/** SQLite planning on the run's own database: `plan.query`, `plan.exec`, and `plan.time` in the worker. */
export function createSqliteAdapter(database: PlanningDatabase): DialectAdapter {
  const fills = new WeakMap<FillTable, SqliteFill>();
  const idMapTables: string[] = [];
  const query = (sql: string, args: unknown[] | Readonly<Record<string, unknown>> = []) =>
    queryRows(database, { statement: { sql, args } });
  const exec = (sql: string) => database.call("plan.exec", { sql }).then(() => undefined);

  return {
    async introspect() {
      const objects = await query(
        "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
      );
      const introspectedTables: IntrospectedTable[] = [];
      const details = new Map<IntrospectedTable, SqliteFill>();

      for (const object of objects) {
        const name = stringValue(object.name);
        const isWithoutRowid = /\bWITHOUT\s+ROWID\b/i.test(stringValue(object.sql));
        const columns = await query(`SELECT * FROM pragma_table_xinfo(${sqlLiteral(name)})`);
        const primaryKey = columns.filter((column) => numberValue(column.pk) > 0);
        const table: IntrospectedTable = { name, columns: [], indexes: [], foreignKeys: [], parents: [] };
        const detail: SqliteFill = {
          columns: [],
          uniqueColumns: new Set(),
          radixKeys: new Set(),
          bases: new Map(),
          generated: 0,
        };

        for (const column of columns) {
          const declaredType = stringValue(column.type);
          table.columns.push(stringValue(column.name));
          detail.columns.push({
            name: stringValue(column.name),
            affinity: getAffinity(declaredType),
            notNull: numberValue(column.notnull) === 1,
            hasDefault: column.dflt_value !== null && column.dflt_value !== undefined,
            generated: numberValue(column.hidden) >= 2,
            rowid:
              !isWithoutRowid &&
              primaryKey.length === 1 &&
              numberValue(column.pk) === 1 &&
              /^integer$/i.test(declaredType.trim()),
          });
        }

        for (const index of await query(`SELECT * FROM pragma_index_list(${sqlLiteral(name)})`)) {
          const indexName = stringValue(index.name);
          const indexInfo = await query(`SELECT name FROM pragma_index_info(${sqlLiteral(indexName)}) ORDER BY seqno`);
          const indexColumns = indexInfo.map((row) => stringValue(row.name));
          table.indexes.push({ name: indexName, columns: indexColumns });

          if (numberValue(index.unique) === 1 && numberValue(index.partial) === 0 && indexColumns.every(Boolean)) {
            addUnique(detail, indexColumns);
          }
        }

        if (primaryKey.length > 0) {
          const keyColumns = primaryKey
            .toSorted((left, right) => numberValue(left.pk) - numberValue(right.pk))
            .map((column) => stringValue(column.name));
          table.indexes.push({ name: `${name} primary key`, columns: keyColumns });
          addUnique(detail, keyColumns);
        }

        const keys = new Map<number, { columns: string[]; referencedTable: string; referencedColumns: string[] }>();

        for (const key of await query(`SELECT * FROM pragma_foreign_key_list(${sqlLiteral(name)}) ORDER BY id, seq`)) {
          const entry = keys.get(numberValue(key.id)) ?? {
            columns: [],
            referencedTable: stringValue(key.table),
            referencedColumns: [],
          };
          entry.columns.push(stringValue(key.from));
          // A foreign key to the parent's primary key may leave `to` empty.
          entry.referencedColumns.push(key.to === null ? "" : stringValue(key.to));
          keys.set(numberValue(key.id), entry);
        }

        table.foreignKeys.push(...keys.values());
        introspectedTables.push(table);
        details.set(table, detail);
      }

      for (const table of introspectedTables) {
        const detail = details.get(table);

        if (detail === undefined) {
          continue;
        }

        for (const key of table.foreignKeys) {
          const parent = introspectedTables.find(
            (entry) => entry.name.toLowerCase() === key.referencedTable.toLowerCase(),
          );

          if (parent === undefined) {
            continue;
          }

          if (key.referencedColumns.some((column) => column === "")) {
            const parentKey = parent.indexes.find((index) => index.name === `${parent.name} primary key`)?.columns ?? [
              "rowid",
            ];
            key.referencedColumns = [...parentKey];
          }

          table.parents.push(introspectedTables.indexOf(parent));

          const hasNotNullKeyColumn = key.columns.some(
            (column) => detail.columns.find((entry) => entry.name === column)?.notNull,
          );

          if (parent === table && hasNotNullKeyColumn) {
            table.unfillable = `${table.name} references itself through a column that cannot be null`;
          }
        }

        for (const unique of detail.uniqueColumns) {
          if (!unique.startsWith("\u0000")) {
            continue;
          }

          const uniqueColumns = unique.slice(1).split("\u0000");

          for (const [index, key] of table.foreignKeys.entries()) {
            if (key.columns.some((column) => uniqueColumns.includes(column))) {
              detail.radixKeys.add(index);
            }
          }
        }

        for (const column of detail.columns) {
          const isNumeric =
            column.affinity === "integer" || column.affinity === "real" || column.affinity === "numeric";

          if (detail.uniqueColumns.has(column.name) && isNumeric) {
            const [row] = await query(
              `SELECT coalesce(max(${quoteIdentifier(column.name)}), 0) AS base FROM ${quoteIdentifier(table.name)}`,
            );
            detail.bases.set(column.name, Math.ceil(numberValue(row?.base)));
          }
        }

        fills.set(table, detail);
      }

      return introspectedTables;
    },

    async countRows(table) {
      const [row] = await query(`SELECT count(*) AS rows FROM ${quoteIdentifier(table.name)}`);

      return numberValue(row?.rows);
    },

    async fill(tables, targets) {
      // Generated rows reference rows that exist; skipping the per-row checks halves the fill.
      await exec("PRAGMA foreign_keys = OFF");

      try {
        for (const table of tables) {
          const detail = fills.get(table);
          const target = targets.get(table);

          if (detail === undefined || target === undefined) {
            continue;
          }

          const currentRows = await this.countRows(table);
          const parents: ({ index: number; name: string; rows: number } | undefined)[] = [];

          for (const [index, key] of table.foreignKeys.entries()) {
            const parent = tables.find((entry) => entry.name.toLowerCase() === key.referencedTable.toLowerCase());

            if (parent === undefined || parent === table) {
              parents.push(undefined);

              continue;
            }

            const name = `drizzle_run_ids_${idMapTables.length + 1}`;
            idMapTables.push(name);
            const columns = key.referencedColumns.map((column, position) => `c${position}`);
            await exec(`CREATE TEMP TABLE ${name} (n INTEGER PRIMARY KEY, ${columns.join(", ")});
              INSERT INTO ${name} (${columns.join(", ")}) SELECT ${key.referencedColumns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(parent.name)}`);
            parents.push({ index, name, rows: await this.countRows(parent) });
          }

          const radix = parents.filter(
            (parent): parent is NonNullable<typeof parent> =>
              parent !== undefined && detail.radixKeys.has(parent.index),
          );
          const capacity = radix.reduce((product, parent) => product * parent.rows, 1);
          const addedRows = Math.min(
            target - currentRows,
            radix.length === 0 ? Number.POSITIVE_INFINITY : capacity - detail.generated,
          );
          const isParentMissing = table.foreignKeys.some((key, index) => {
            const parent = parents[index];

            return parent === undefined
              ? key.referencedTable.toLowerCase() !== table.name.toLowerCase()
              : parent.rows === 0;
          });

          if (addedRows > 0 && !isParentMissing) {
            const start = detail.generated + 1;
            const end = detail.generated + addedRows;
            const insertColumns: string[] = [];
            const values: string[] = [];

            for (const column of detail.columns) {
              if (column.generated || column.rowid) {
                continue;
              }

              const keyIndex = table.foreignKeys.findIndex((key) => key.columns.includes(column.name));

              if (keyIndex >= 0) {
                const parent = parents[keyIndex];

                if (parent === undefined) {
                  // A nullable self reference stays NULL: generated rows form no trees.
                  continue;
                }

                const radixPosition = radix.indexOf(parent);
                const divisor = radix
                  .slice(0, Math.max(0, radixPosition))
                  .reduce((product, entry) => product * entry.rows, 1);
                const position =
                  radixPosition >= 0
                    ? `1 + ((g.n - 1) / ${divisor}) % ${parent.rows}`
                    : `1 + (g.n * 7919) % ${parent.rows}`;
                const idMapColumn = `c${table.foreignKeys[keyIndex].columns.indexOf(column.name)}`;
                insertColumns.push(quoteIdentifier(column.name));
                values.push(`(SELECT ${idMapColumn} FROM ${parent.name} WHERE n = ${position})`);

                continue;
              }

              insertColumns.push(quoteIdentifier(column.name));
              values.push(toValueExpression(column, detail));
            }

            await exec(`WITH RECURSIVE g(n) AS (SELECT ${start} UNION ALL SELECT n + 1 FROM g WHERE n < ${end})
              INSERT INTO ${quoteIdentifier(table.name)} (${insertColumns.join(", ")}) SELECT ${values.join(", ")} FROM g`);
            detail.generated = end;
          }

          for (const parent of parents) {
            if (parent !== undefined) {
              await exec(`DROP TABLE IF EXISTS ${parent.name}`);
            }
          }
        }
      } catch (cause) {
        throw new Error(`Drizzle Run could not fill the tables: ${getErrorText(cause)}`, { cause });
      } finally {
        await exec("PRAGMA foreign_keys = ON");
      }
    },

    async analyze() {
      await exec("ANALYZE");
    },

    async explain(statement, size: QueryPlanSize) {
      const rows = await query(`EXPLAIN QUERY PLAN ${statement.sql}`, statement.namedValues ?? statement.values);
      let timing: SqliteRawPlan["timing"];

      try {
        const result = await database.call("plan.time", {
          statement: { sql: statement.sql, args: statement.namedValues ?? statement.values },
          rollback: isWrite(statement.sql),
          budgetMs: TIMING_BUDGET_MS,
          maxSamples: TIMING_MAX_SAMPLES,
        });
        const timingResult = TimingResultSchema.safeParse(result);
        const samples = timingResult.success ? timingResult.data.samples.map(numberValue) : [];

        if (samples.length === 0) {
          throw new Error("SQLite returned no timing");
        }

        timing = {
          samples: samples.length,
          medianMs: roundToMicroseconds(median(samples)),
          minMs: roundToMicroseconds(Math.min(...samples)),
          maxMs: roundToMicroseconds(Math.max(...samples)),
        };
      } catch (cause) {
        timing = { error: serializeError(cause) };
      }

      return {
        database: "sqlite",
        size,
        rows: rows.map((row) => ({
          id: numberValue(row.id),
          parent: numberValue(row.parent),
          notused: numberValue(row.notused),
          detail: stringValue(row.detail),
        })),
        timing,
      };
    },

    read(raw, statement, tables, rows) {
      if (raw.database !== "sqlite") {
        throw new TypeError("A SQLite reading needs a SQLite plan");
      }

      return readSqlitePlan({ rows: raw.rows, sql: statement.sql, tables, tableRows: rows });
    },

    measure(raw: RawQueryPlan) {
      return raw.database === "sqlite" && "medianMs" in raw.timing
        ? { unit: "ms", value: raw.timing.medianMs }
        : undefined;
    },

    usesIndex(raw, name) {
      return raw.database === "sqlite" && sqliteUsesIndex(raw.rows, name);
    },

    async indexNames() {
      const rows = await query("SELECT name FROM sqlite_schema WHERE type = 'index'");

      return new Set(rows.map((row) => stringValue(row.name)));
    },

    async createIndex(table: PlanTable, name, columns) {
      const indexColumns = columns.map(quoteIdentifier).join(", ");

      await exec(
        `CREATE INDEX ${quoteIdentifier(name)} ON ${quoteIdentifier(table.name)} (${indexColumns}); ANALYZE ${quoteIdentifier(name)}`,
      );
    },

    async dropIndex(_table, name) {
      await exec(`DROP INDEX IF EXISTS ${quoteIdentifier(name)}`);
    },

    async cleanup() {
      await exec("PRAGMA foreign_keys = ON");

      for (const name of idMapTables.splice(0)) {
        await exec(`DROP TABLE IF EXISTS ${name}`);
      }
    },
  };
}

function addUnique(detail: SqliteFill, columns: readonly string[]): void {
  detail.uniqueColumns.add(columns.length === 1 ? columns[0] : `\u0000${columns.join("\u0000")}`);
}

/** SQLite's column affinity rules, from the declared type. */
function getAffinity(declaredType: string): SqliteColumn["affinity"] {
  const type = declaredType.toUpperCase();

  if (type.includes("INT")) {
    return "integer";
  }

  if (/CHAR|CLOB|TEXT/.test(type)) {
    return "text";
  }

  if (type === "" || type.includes("BLOB")) {
    return "blob";
  }

  if (/REAL|FLOA|DOUB/.test(type)) {
    return "real";
  }

  return "numeric";
}

function toValueExpression(column: SqliteColumn, detail: SqliteFill): string {
  const isUnique = detail.uniqueColumns.has(column.name);
  const base = detail.bases.get(column.name) ?? 0;
  const label = sqlLiteral(`${column.name}-`);

  switch (column.affinity) {
    case "integer":
    case "numeric":
      return isUnique ? `${base} + g.n` : "(g.n * 7919) % 1000000";

    case "real":
      return isUnique ? `${base} + g.n` : "((g.n * 7919) % 1000000) / 100.0";

    case "blob":
      return `CAST(${label} || g.n AS BLOB)`;

    case "text":
      return `${label} || g.n`;
  }
}

function roundToMicroseconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
