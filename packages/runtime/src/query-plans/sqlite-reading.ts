import type { QueryPlanReading, SqliteQueryPlanRow } from "@drizzle-run/core/contracts";
import { escapeRegExp, uniq } from "es-toolkit";

import { addCandidate, findTable, isUnindexedForeignKey, type IndexCandidate, type PlanTable } from "./schema.ts";
import { formatRows } from "./sizes.ts";
import {
  columnReferences,
  hasTopLevel,
  hasTopLevelAggregate,
  mustReadWholeTables,
  orderByColumns,
  topLevelClause,
} from "./sql-text.ts";
import type { PlanStep } from "./steps.ts";

interface SqliteAccess {
  name: string;
  table: PlanTable | undefined;
  kind: "full_scan" | "search" | "automatic_index";
  index?: string;
  /** The `col=? AND col2>?` part SQLite prints for a search. */
  terms: string[];
}

const SCAN_PATTERN = /^SCAN (?!CONSTANT ROW|\()(\S+)(?: AS \S+)?(?: USING (?:COVERING )?INDEX (\S+))?/;
const SEARCH_PATTERN =
  /^SEARCH (\S+)(?: AS \S+)? USING (AUTOMATIC (?:PARTIAL )?(?:COVERING )?INDEX|(?:COVERING )?INDEX (\S+)|INTEGER PRIMARY KEY|PRIMARY KEY)(?: \((.*)\))?/;

/** A plan line that names a table: "SCAN users", "SEARCH posts USING INDEX posts_author_idx (author_id=?)". */
const TABLE_STEP_PATTERN = /^(SCAN|SEARCH|BLOOM FILTER ON) (\S+)(?: (.+))?$/;

/** The `EXPLAIN QUERY PLAN` rows as steps, nested by their parent ids */
export function sqliteSteps(rows: readonly SqliteQueryPlanRow[]): PlanStep[] {
  const depths = new Map<number, number>([[0, -1]]);

  return rows.map((row) => {
    const depth = (depths.get(row.parent) ?? -1) + 1;
    depths.set(row.id, depth);
    const match = TABLE_STEP_PATTERN.exec(row.detail);

    if (match === null || match[2] === "CONSTANT") {
      return { depth, label: row.detail, operation: row.detail };
    }

    const step: PlanStep = { depth, label: row.detail, operation: match[1], relation: match[2] };

    if (match[3] !== undefined) {
      step.detail = match[3];
    }

    return step;
  });
}

/** True when any plan row uses the named index */
export function sqliteUsesIndex(rows: readonly SqliteQueryPlanRow[], name: string): boolean {
  return rows.some((row) => new RegExp(`\\bINDEX ${escapeRegExp(name)}\\b`).test(row.detail));
}

/** Drizzle Run's reading of SQLite's `EXPLAIN QUERY PLAN` rows; the statement fills in what they omit. */
export function readSqlitePlan(input: {
  rows: readonly SqliteQueryPlanRow[];
  sql: string;
  tables: readonly PlanTable[];
  tableRows: ReadonlyMap<PlanTable, number>;
}): Omit<QueryPlanReading, "indexes"> & { candidates: IndexCandidate[] } {
  const accesses = withoutForeignKeyCounterScans(input.sql, collectAccesses(input.rows, input.tables));
  const sorts = input.rows.some((row) =>
    /^USE TEMP B-TREE FOR (?:ORDER BY|RIGHT PART OF ORDER BY|LAST TERM OF ORDER BY)/.test(row.detail),
  );
  const groups = input.rows.some((row) => /^USE TEMP B-TREE FOR (?:GROUP BY|DISTINCT)/.test(row.detail));
  // SQLite prints no LIMIT: a lone unfiltered scan under a top-level limit stops after the first rows.
  const firstRowsOnly =
    accesses.length === 1 &&
    hasTopLevel(input.sql, "limit") &&
    !hasTopLevel(input.sql, "where") &&
    !hasTopLevel(input.sql, "group by") &&
    !hasTopLevel(input.sql, "distinct") &&
    !hasTopLevelAggregate(input.sql) &&
    !sorts &&
    !groups;
  const growingTables = firstRowsOnly
    ? []
    : uniq(accesses.filter((access) => access.kind !== "search").map((access) => access.name));
  const verdict: QueryPlanReading["verdict"] =
    growingTables.length === 0 ? { kind: "stays_fast" } : { kind: "grows", tables: growingTables };
  const summary = getSummary(input.sql, accesses, input.tableRows, { sorts, groups, firstRowsOnly });
  const candidates = mustReadWholeTables(input.sql) ? [] : getIndexCandidates(input.sql, accesses, sorts);

  return { summary, verdict, candidates };
}

function collectAccesses(rows: readonly SqliteQueryPlanRow[], tables: readonly PlanTable[]): SqliteAccess[] {
  const accesses: SqliteAccess[] = [];

  for (const row of rows) {
    const scan = SCAN_PATTERN.exec(row.detail);

    if (scan !== null) {
      const table = findTable(tables, scan[1]);

      if (table !== undefined) {
        accesses.push({
          name: scan[1],
          table,
          kind: "full_scan",
          ...(scan[2] === undefined ? {} : { index: scan[2] }),
          terms: [],
        });
      }

      continue;
    }

    const search = SEARCH_PATTERN.exec(row.detail);

    if (search !== null) {
      const table = findTable(tables, search[1]);
      const isAutomatic = search[2].startsWith("AUTOMATIC");
      accesses.push({
        name: search[1],
        table,
        kind: isAutomatic ? "automatic_index" : "search",
        ...(search[3] === undefined ? {} : { index: search[3] }),
        terms: (search[4] ?? "")
          .split(/\s+AND\s+/)
          .map((term) => term.trim())
          .filter(Boolean),
      });
    }
  }

  return accesses;
}

/**
 * An INSERT plan lists a scan of every table that references the target: SQLite runs it only to settle
 * foreign key violations still pending in the transaction, so it says nothing about the insert itself.
 */
function withoutForeignKeyCounterScans(sql: string, accesses: SqliteAccess[]): SqliteAccess[] {
  const insertTargetPattern = /^\s*insert\s+(?:or\s+\w+\s+)?into\s+(?:["`[]?\w+["`\]]?\.)?["`[]?(\w+)["`\]]?/i;
  const target = insertTargetPattern.exec(sql)?.[1];

  if (target === undefined) {
    return accesses;
  }

  return accesses.filter(
    (access) =>
      access.kind !== "full_scan" ||
      access.table === undefined ||
      access.table.name.toLowerCase() === target.toLowerCase() ||
      !access.table.foreignKeys.some((key) => key.referencedTable.toLowerCase() === target.toLowerCase()),
  );
}

function getWriteVerb(sql: string): string | undefined {
  if (/^\s*insert\b/i.test(sql)) {
    return "Inserts";
  }

  if (/^\s*update\b/i.test(sql)) {
    return "Updates";
  }

  if (/^\s*delete\b/i.test(sql)) {
    return "Deletes";
  }

  return undefined;
}

function getSummary(
  sql: string,
  accesses: SqliteAccess[],
  tableRows: ReadonlyMap<PlanTable, number>,
  shape: { sorts: boolean; groups: boolean; firstRowsOnly: boolean },
): string {
  const verb = getWriteVerb(sql);
  const getReadsText = (access: SqliteAccess) => {
    const rows = access.table === undefined ? undefined : tableRows.get(access.table);

    return rows === undefined ? "" : `, reads ${formatRows(rows)} rows`;
  };
  const describe = (access: SqliteAccess, isFirst: boolean): string => {
    switch (access.kind) {
      case "full_scan":
        return isFirst ? `Full scan of ${access.name}${getReadsText(access)}` : `scans ${access.name}`;

      case "automatic_index":
        return `builds a temporary index on ${access.name} each call`;

      case "search":
        return access.index === undefined
          ? `${isFirst ? "Primary key lookup" : "looks up"} on ${access.name}`
          : `${isFirst ? "Index search" : "searches"} on ${access.name} using ${access.index}`;
    }
  };
  let sentence: string;

  if (accesses.length === 0) {
    sentence =
      verb === undefined ? "Computes its result without reading a table" : `${verb} without reading a table first`;

    return verb === "Inserts" ? "Inserts without reading a table first" : sentence;
  }

  if (shape.firstRowsOnly) {
    sentence = `Reads the first rows of ${accesses[0].name} and stops`;
  } else if (accesses.length === 1) {
    sentence = describe(accesses[0], true);
  } else {
    const [first, ...rest] = accesses;
    sentence = first.kind === "full_scan" ? `Scans ${first.name}` : describe(first, true);
    sentence += `, ${rest.map((access) => describe(access, false)).join(", ")}`;
  }

  if (shape.sorts) {
    sentence += ", sorts every row";
  }

  if (shape.groups) {
    sentence += ", groups with a temporary b-tree";
  }

  return verb === undefined ? sentence : `${verb}; ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;
}

function getIndexCandidates(sql: string, accesses: SqliteAccess[], sorts: boolean): IndexCandidate[] {
  const candidates: IndexCandidate[] = [];
  const scanned = accesses.filter((access) => access.kind === "full_scan" && access.table !== undefined);
  const where = topLevelClause(sql, "where");

  for (const access of scanned) {
    const table = access.table;

    if (table === undefined || where === undefined) {
      continue;
    }

    for (const [qualifier, column] of columnReferences(where)) {
      const isOwnColumn = qualifier === undefined ? scanned.length === 1 : qualifier === access.name;

      if (isOwnColumn && table.columns.includes(column)) {
        addCandidate(candidates, { trigger: "filtered_scan", table, columns: [column] });
      }
    }
  }

  for (const access of accesses) {
    if (access.kind !== "automatic_index" || access.table === undefined) {
      continue;
    }

    const columns = access.terms
      .map((term) => /^"?([^"=<>!\s]+)"?\s*[=<>]/.exec(term)?.[1])
      .filter((column): column is string => column !== undefined);

    if (columns.length > 0 && isUnindexedForeignKey(access.table, columns)) {
      addCandidate(candidates, { trigger: "foreign_key_join", table: access.table, columns });
    }
  }

  if (sorts && hasTopLevel(sql, "limit") && scanned.length === 1 && scanned[0].table !== undefined) {
    const table = scanned[0].table;
    const columns = orderByColumns(sql);

    const isOwnSort = columns.every(
      ([qualifier, column]) => (qualifier === undefined || qualifier === table.name) && table.columns.includes(column),
    );

    if (columns.length > 0 && isOwnSort) {
      addCandidate(candidates, { trigger: "sorted_limit", table, columns: columns.map(([, column]) => column) });
    }
  }

  return candidates;
}
