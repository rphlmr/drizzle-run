import { serializeError, type PostgresRawPlan, type RawQueryPlan } from "@drizzle-run/core/contracts";

import { getErrorText } from "../machines/error-text.ts";
import {
  jsonList,
  numberValue,
  queryRows,
  sqlLiteral,
  stringValue,
  type DialectAdapter,
  type FillTable,
  type PlanningDatabase,
} from "./adapter.ts";
import { parsePostgresPlan, postgresTotalCost, postgresUsesIndex, readPostgresPlan } from "./postgres-reading.ts";
import type { PlanTable } from "./schema.ts";
import { quoteIdentifier } from "./sql-text.ts";

interface PostgresColumn {
  name: string;
  type: string;
  typeName: string;
  category: string;
  enumLabels: string[];
  elementCategory: string | undefined;
  notNull: boolean;
  hasDefault: boolean;
  identity: string;
  generated: boolean;
  serial: boolean;
}

interface PostgresFill {
  columns: PostgresColumn[];
  uniqueColumns: Set<string>;
  /** Foreign keys whose columns form a unique key on their own, so each parent row is used once. */
  radixKeys: Set<number>;
  /** Largest existing value of each unique numeric column, so generated values never collide. */
  bases: Map<string, number>;
  generated: number;
}

const QUERY_PLAN_COLUMN = "QUERY PLAN";

/**
 * Real time is measured only for plans Postgres estimates below this cost. EXPLAIN ANALYZE runs the statement, and
 * PGlite can neither interrupt it nor honor `statement_timeout`: in the browser one cost unit takes about 2 to 10 µs.
 * A timing runs the statement twice (the JSON and the text plan), so this keeps both under a few seconds of the
 * planning budget, where a lateral subquery over 100k users and 1M posts would run for an hour.
 */
export const MAX_TIMED_COST = 500_000;

type IntrospectedTable = FillTable & {
  columns: string[];
  indexes: { name: string; columns: string[] }[];
  foreignKeys: {
    columns: string[];
    referencedTable: string;
    referencedSchema?: string;
    referencedColumns: string[];
  }[];
  parents: number[];
};

const toTableKey = (schema: unknown, table: unknown) => `${stringValue(schema)}.${stringValue(table)}`;

const qualified = (table: PlanTable) => {
  const schemaPrefix = table.schema === undefined ? "" : `${quoteIdentifier(table.schema)}.`;

  return `${schemaPrefix}${quoteIdentifier(table.name)}`;
};

/** Postgres planning: everything goes through `plan.query` and `plan.exec` on the run's own PGlite. */
export function createPostgresAdapter(database: PlanningDatabase): DialectAdapter {
  const fills = new WeakMap<FillTable, PostgresFill>();
  const idMapTables: string[] = [];
  const query = (sql: string, params: unknown[] = []) => queryRows(database, { sql, params });
  const exec = (sql: string) => database.call("plan.exec", { sql }).then(() => undefined);

  return {
    async introspect() {
      const [columns, indexes, foreignKeys] = await Promise.all([
        query(`SELECT n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS type, t.typname AS type_name, t.typcategory AS category,
            et.typcategory AS element_category, a.attnotnull AS not_null, a.atthasdef AS has_default,
            a.attidentity AS identity, a.attgenerated AS generated, pg_get_expr(d.adbin, d.adrelid) AS default_expression,
            (SELECT array_to_json(array_agg(e.enumlabel ORDER BY e.enumsortorder)) FROM pg_enum e WHERE e.enumtypid = a.atttypid) AS enum_labels
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_type t ON t.oid = a.atttypid
          LEFT JOIN pg_type et ON et.oid = t.typelem AND t.typcategory = 'A'
          LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
            AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
          ORDER BY n.nspname, c.relname, a.attnum`),
        query(`SELECT n.nspname AS schema_name, c.relname AS table_name, i.relname AS index_name, x.indisunique AS is_unique,
            x.indexprs IS NULL AND x.indpred IS NULL AS plain,
            array_to_json(ARRAY(SELECT a.attname FROM unnest(x.indkey) WITH ORDINALITY k(attnum, position)
              JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum ORDER BY k.position)) AS columns
          FROM pg_index x
          JOIN pg_class c ON c.oid = x.indrelid
          JOIN pg_class i ON i.oid = x.indexrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`),
        query(`SELECT n.nspname AS schema_name, c.relname AS table_name, rn.nspname AS referenced_schema, rc.relname AS referenced_table,
            array_to_json(ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(attnum, position)
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.position)) AS columns,
            array_to_json(ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(attnum, position)
              JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.position)) AS referenced_columns
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_class rc ON rc.oid = con.confrelid
          JOIN pg_namespace rn ON rn.oid = rc.relnamespace
          WHERE con.contype = 'f' AND n.nspname NOT IN ('pg_catalog', 'information_schema')`),
      ]);
      const tables = new Map<string, IntrospectedTable>();
      const details = new Map<FillTable, PostgresFill>();

      for (const row of columns) {
        const key = toTableKey(row.schema_name, row.table_name);
        let table = tables.get(key);

        if (table === undefined) {
          table = {
            name: stringValue(row.table_name),
            schema: stringValue(row.schema_name),
            columns: [],
            indexes: [],
            foreignKeys: [],
            parents: [],
          };
          tables.set(key, table);
          details.set(table, {
            columns: [],
            uniqueColumns: new Set(),
            radixKeys: new Set(),
            bases: new Map(),
            generated: 0,
          });
        }

        const defaultExpression = row.default_expression === null ? undefined : stringValue(row.default_expression);

        table.columns.push(stringValue(row.column_name));
        details.get(table)?.columns.push({
          name: stringValue(row.column_name),
          type: stringValue(row.type),
          typeName: stringValue(row.type_name),
          category: stringValue(row.category),
          elementCategory: row.element_category === null ? undefined : stringValue(row.element_category),
          enumLabels: row.enum_labels === null ? [] : jsonList(row.enum_labels),
          notNull: row.not_null === true,
          hasDefault: row.has_default === true,
          identity: stringValue(row.identity),
          generated: stringValue(row.generated) !== "",
          serial: defaultExpression?.startsWith("nextval(") ?? false,
        });
      }

      const introspectedTables: IntrospectedTable[] = [...tables.values()];

      for (const row of indexes) {
        const table = tables.get(toTableKey(row.schema_name, row.table_name));
        const indexColumns = jsonList(row.columns);

        if (table === undefined) {
          continue;
        }

        table.indexes.push({ name: stringValue(row.index_name), columns: indexColumns });

        if (row.is_unique === true && row.plain === true) {
          const detail = details.get(table);
          const foreignKeyColumns = new Set(
            foreignKeys
              .filter(
                (key) => toTableKey(key.schema_name, key.table_name) === toTableKey(row.schema_name, row.table_name),
              )
              .flatMap((key) => jsonList(key.columns)),
          );

          if (indexColumns.some((column) => !foreignKeyColumns.has(column))) {
            // One generated-unique column is enough to keep the whole key unique.
            const own = indexColumns.find((column) => !foreignKeyColumns.has(column));

            if (own !== undefined) {
              detail?.uniqueColumns.add(own);
            }
          } else {
            detail?.uniqueColumns.add(`\u0000${indexColumns.join("\u0000")}`);
          }
        }
      }

      for (const row of foreignKeys) {
        const table = tables.get(toTableKey(row.schema_name, row.table_name));
        const parent = tables.get(toTableKey(row.referenced_schema, row.referenced_table));

        if (table === undefined || parent === undefined) {
          continue;
        }

        const keyColumns = jsonList(row.columns);
        const detail = details.get(table);

        table.foreignKeys.push({
          columns: keyColumns,
          referencedTable: parent.name,
          referencedSchema: parent.schema,
          referencedColumns: jsonList(row.referenced_columns),
        });
        table.parents.push(introspectedTables.indexOf(parent));

        const hasNotNullKeyColumn = keyColumns.some(
          (column) => detail?.columns.find((entry) => entry.name === column)?.notNull,
        );

        if (parent === table && hasNotNullKeyColumn) {
          table.unfillable = `${table.name} references itself through a column that cannot be null`;
        }
      }

      for (const table of introspectedTables) {
        const detail = details.get(table);

        if (detail === undefined) {
          continue;
        }

        // A unique key made only of foreign key columns: spread those keys so every combination is new.
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
          const isOmitted = column.generated || getForeignKeyPosition(table, column.name) !== undefined;

          if (
            !isOmitted &&
            toValueExpression(table, column, detail) === undefined &&
            column.notNull &&
            !column.hasDefault
          ) {
            table.unfillable ??= `Drizzle Run cannot generate ${column.type} values for ${table.name}.${column.name}`;
          }

          if (detail.uniqueColumns.has(column.name) && column.category === "N") {
            const [row] = await query(
              `SELECT coalesce(max(${quoteIdentifier(column.name)}), 0)::float8 AS base FROM ${qualified(table)}`,
            );
            detail.bases.set(column.name, Math.ceil(numberValue(row?.base)));
          }
        }

        fills.set(table, detail);
      }

      return introspectedTables;
    },

    async countRows(table) {
      const [row] = await query(`SELECT count(*)::float8 AS rows FROM ${qualified(table)}`);

      return numberValue(row?.rows);
    },

    async fill(tables, targets) {
      // Generated rows reference rows that exist, so foreign key triggers can wait; this halves the fill.
      await exec("SET session_replication_role = replica");

      try {
        for (const table of tables) {
          const detail = fills.get(table);
          const target = targets.get(table);

          if (detail === undefined || target === undefined) {
            continue;
          }

          const currentRows = await this.countRows(table);
          const parents = await Promise.all(
            table.foreignKeys.map(async (key, index) => {
              const parent = tables.find(
                (entry) => entry.name === key.referencedTable && entry.schema === key.referencedSchema,
              );

              if (parent === undefined || parent === table) {
                return undefined;
              }

              const name = `drizzle_run_ids_${idMapTables.length + 1}`;
              idMapTables.push(name);
              await exec(
                `CREATE TEMP TABLE ${name} AS SELECT row_number() OVER () AS n, ` +
                  `${key.referencedColumns.map(quoteIdentifier).join(", ")} FROM ${qualified(parent)}`,
              );
              const rows = await this.countRows(parent);

              return { index, name, rows };
            }),
          );
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

            return parent === undefined ? !isSelfReference(table, key) : parent.rows === 0;
          });

          if (addedRows > 0 && !isParentMissing) {
            const start = detail.generated + 1;
            const end = detail.generated + addedRows;
            const insertColumns: string[] = [];
            const values: string[] = [];
            const joins: string[] = [];
            let isIdentityAlways = false;

            for (const parent of parents) {
              if (parent === undefined) {
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
              joins.push(`JOIN ${parent.name} AS p${parent.index} ON p${parent.index}.n = ${position}`);
            }

            for (const column of detail.columns) {
              const key = getForeignKeyPosition(table, column.name);
              const isSelfReferenceColumn = table.foreignKeys.some(
                (entry) => isSelfReference(table, entry) && entry.columns.includes(column.name),
              );

              // A nullable self reference stays NULL: generated rows form no trees.
              if (column.generated || isSelfReferenceColumn) {
                continue;
              }

              if (key !== undefined) {
                const parent = parents[key.index];

                if (parent === undefined) {
                  continue;
                }

                const referencedColumn = table.foreignKeys[key.index].referencedColumns[key.position];
                insertColumns.push(quoteIdentifier(column.name));
                values.push(`p${parent.index}.${quoteIdentifier(referencedColumn)}`);

                continue;
              }

              const expression = toValueExpression(table, column, detail);

              if (expression === undefined) {
                continue;
              }

              isIdentityAlways ||= column.identity === "a";
              insertColumns.push(quoteIdentifier(column.name));
              values.push(expression);
            }

            await exec(`INSERT INTO ${qualified(table)} (${insertColumns.join(", ")})${isIdentityAlways ? " OVERRIDING SYSTEM VALUE" : ""}
              SELECT ${values.join(", ")} FROM generate_series(${start}::bigint, ${end}::bigint) AS g(n) ${joins.join(" ")}`);
            detail.generated = end;

            // Explicit values went past the sequence; move it on so a planned INSERT gets a free id.
            for (const column of detail.columns.filter((entry) => entry.serial || entry.identity !== "")) {
              await query(
                `SELECT setval(pg_get_serial_sequence($1, $2), (SELECT max(${quoteIdentifier(column.name)}) FROM ${qualified(table)}))`,
                [qualified(table), column.name],
              );
            }
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
        await exec("SET session_replication_role = DEFAULT");
      }
    },

    async analyze(tables) {
      for (const table of tables) {
        await exec(`ANALYZE ${qualified(table)}`);
      }
    },

    async explain(statement, size, measure) {
      const json = await query(`EXPLAIN (FORMAT JSON) ${statement.sql}`, statement.values);
      const text = await query(`EXPLAIN ${statement.sql}`, statement.values);
      const raw: PostgresRawPlan = {
        database: "postgresql",
        size,
        json: stringValue(json[0]?.[QUERY_PLAN_COLUMN]),
        text: text.map((row) => stringValue(row[QUERY_PLAN_COLUMN])).join("\n"),
      };

      const estimatedCost = measure ? postgresTotalCost(raw.json) : 0;

      if (estimatedCost > MAX_TIMED_COST) {
        raw.analyze = {
          error: serializeError(
            new Error(
              `Not timed: Postgres estimates this query at cost ${Math.round(estimatedCost)}, too slow to run here ` +
                `(the limit is ${MAX_TIMED_COST}). Its plan is the estimate.`,
            ),
          ),
        };
      } else if (measure) {
        // EXPLAIN ANALYZE runs the statement; the transaction keeps writes from landing.
        await exec("BEGIN");

        try {
          const analyzedJson = await query(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement.sql}`, statement.values);
          await exec("ROLLBACK");
          await exec("BEGIN");
          const analyzedText = await query(`EXPLAIN ANALYZE ${statement.sql}`, statement.values);
          raw.analyze = {
            json: stringValue(analyzedJson[0]?.[QUERY_PLAN_COLUMN]),
            text: analyzedText.map((row) => stringValue(row[QUERY_PLAN_COLUMN])).join("\n"),
          };
        } catch (cause) {
          raw.analyze = { error: serializeError(cause) };
        } finally {
          await exec("ROLLBACK");
        }
      }

      return raw;
    },

    read(raw, statement, tables, rows) {
      if (raw.database !== "postgresql") {
        throw new TypeError("A Postgres reading needs a Postgres plan");
      }

      return readPostgresPlan({
        json: raw.json,
        ...(raw.analyze !== undefined && "json" in raw.analyze ? { analyzeJson: raw.analyze.json } : {}),
        sql: statement.sql,
        tables,
        tableRows: rows,
      });
    },

    measure(raw: RawQueryPlan) {
      return raw.database === "postgresql"
        ? { unit: "cost", value: parsePostgresPlan(raw.json)["Total Cost"] }
        : undefined;
    },

    usesIndex(raw, name) {
      return raw.database === "postgresql" && postgresUsesIndex(raw.json, name);
    },

    async indexNames() {
      const rows = await query("SELECT indexname FROM pg_indexes");

      return new Set(rows.map((row) => stringValue(row.indexname)));
    },

    async createIndex(table, name, columns) {
      await exec(
        `CREATE INDEX ${quoteIdentifier(name)} ON ${qualified(table)} (${columns.map(quoteIdentifier).join(", ")})`,
      );
    },

    async dropIndex(table, name) {
      const schemaPrefix = table.schema === undefined ? "" : `${quoteIdentifier(table.schema)}.`;

      await exec(`DROP INDEX IF EXISTS ${schemaPrefix}${quoteIdentifier(name)}`);
    },

    async cleanup() {
      await exec("SET session_replication_role = DEFAULT");

      for (const name of idMapTables.splice(0)) {
        await exec(`DROP TABLE IF EXISTS ${name}`);
      }
    },
  };
}

function isSelfReference(table: PlanTable, key: PlanTable["foreignKeys"][number]): boolean {
  return key.referencedTable === table.name && key.referencedSchema === table.schema;
}

function getForeignKeyPosition(table: PlanTable, column: string): { index: number; position: number } | undefined {
  for (const [index, key] of table.foreignKeys.entries()) {
    const position = key.columns.indexOf(column);

    if (position >= 0 && !isSelfReference(table, key)) {
      return { index, position };
    }
  }

  return undefined;
}

/** A SQL expression of the row number `g.n` for one column, or undefined to leave it to its default or NULL. */
function toValueExpression(table: PlanTable, column: PostgresColumn, detail: PostgresFill): string | undefined {
  const isUnique = detail.uniqueColumns.has(column.name);
  const label = sqlLiteral(`${column.name}-`);
  const cast = (expression: string) => `(${expression})::${column.type}`;
  const spread = "((g.n * 7919) % 1000000)";
  const base = detail.bases.get(column.name) ?? 0;
  const maxLength = /\((\d+)\)$/.exec(column.type)?.[1];

  if (column.generated) {
    return undefined;
  }

  if (column.enumLabels.length > 0) {
    const labels = column.enumLabels.map(sqlLiteral).join(", ");

    return `(ARRAY[${labels}]::${column.type}[])[1 + (g.n % ${column.enumLabels.length})]`;
  }

  switch (column.typeName) {
    case "bool":
      return "(g.n % 2 = 0)";

    case "uuid":
      return `md5(${sqlLiteral(`${table.name}.${column.name}`)} || g.n)::uuid`;

    case "json":
    case "jsonb":
      return cast("json_build_object('n', g.n)");

    case "bytea":
      return "decode(md5(g.n::text), 'hex')";

    case "date":
      return isUnique ? "date '2000-01-01' + g.n::int" : "date '2020-01-01' + (g.n % 3650)::int";

    case "timestamp":
    case "timestamptz":
      return cast("timestamp '2026-01-01' + g.n * interval '1 second'");

    case "time":
    case "timetz":
      return cast("time '00:00' + (g.n % 86400) * interval '1 second'");

    case "interval":
      return "g.n * interval '1 second'";

    case "inet":
    case "cidr":
      return cast("'10.0.0.0'::inet + g.n");

    case "vector": {
      const dimensions = /\((\d+)\)$/.exec(column.type)?.[1];

      return dimensions === undefined
        ? undefined
        : cast(`array_fill(((g.n % 100) / 100.0)::real, ARRAY[${dimensions}])`);
    }

    default:
      break;
  }

  switch (column.category) {
    case "N":
      if (column.typeName === "int2") {
        return isUnique ? cast(`${base} + g.n`) : cast("(g.n * 7919) % 30000");
      }

      if (isUnique) {
        return cast(`${base} + g.n`);
      }

      return /^(?:int4|int8|oid)$/.test(column.typeName) ? cast(spread) : cast(`${spread} / 100.0`);

    case "S": {
      const text = `${label} || g.n`;

      return cast(maxLength === undefined ? text : `right(${text}, ${maxLength})`);
    }

    case "A":
      switch (column.elementCategory) {
        case "S":
          return cast(`ARRAY[${label} || g.n]`);

        case "N":
          return cast(`ARRAY[${spread}]`);

        case "B":
          return cast("ARRAY[g.n % 2 = 0]");

        case undefined:
        default:
          return undefined;
      }

    default:
      return undefined;
  }
}
