import type { SerializedValue, SqlEvent } from "@drizzle-run/core/contracts";

/** How a result's SQL footer draws a statement: a query row, or a transaction boundary. */
export type StatementKind = "query" | "begin" | "commit" | "rollback" | "savepoint";

/** Reads transaction control from the SQL text; everything else is a query. */
export function getStatementKind(sql: string): StatementKind {
  const text = sql.trim().toLowerCase();

  if (/^(begin|start\s+transaction)\b/.test(text)) {
    return "begin";
  }

  if (/^(commit|end)\b/.test(text)) {
    return "commit";
  }

  if (/^rollback\s+to\b/.test(text) || /^(savepoint|release)\b/.test(text)) {
    return "savepoint";
  }

  if (/^(rollback|abort)\b/.test(text)) {
    return "rollback";
  }

  return "query";
}

/** One statement of the footer, numbered among the queries only. */
export interface FooterStatement {
  statement: SqlEvent;
  kind: StatementKind;
  /** 1-based among the queries; absent for transaction control. */
  number?: number;
}

/** A run of statements, framed when a `begin` opened it. */
export interface FooterGroup {
  transaction?: { outcome: "committed" | "rolled_back" | "open" };
  statements: FooterStatement[];
}

/** Splits the statements into transaction frames and loose queries, numbering the queries in order. */
export function groupFooterStatements(statements: readonly SqlEvent[]): FooterGroup[] {
  const groups: FooterGroup[] = [];
  let current: FooterGroup | undefined;
  let number = 0;

  for (const statement of statements) {
    const kind = getStatementKind(statement.sql);
    const entry: FooterStatement = kind === "query" ? { statement, kind, number: ++number } : { statement, kind };

    if (kind === "begin") {
      current = { transaction: { outcome: "open" }, statements: [entry] };
      groups.push(current);
      continue;
    }

    if (current?.transaction) {
      current.statements.push(entry);

      if (kind === "commit" || kind === "rollback") {
        current.transaction.outcome = kind === "commit" ? "committed" : "rolled_back";
        current = undefined;
      }

      continue;
    }

    if (!current) {
      current = { statements: [] };
      groups.push(current);
    }

    current.statements.push(entry);
  }

  return groups;
}

/** The queries among the statements, leaving out transaction control. */
export function countQueries(statements: readonly SqlEvent[]): number {
  return statements.filter((statement) => getStatementKind(statement.sql) === "query").length;
}

/** One bound value with the placeholder it fills, such as `$1`, `?2` or `:name`. */
export interface StatementParam {
  label: string;
  value: SerializedValue;
}

/** Pairs each bound value with its placeholder: named SQLite bindings keep their names. */
export function getStatementParams(statement: SqlEvent): StatementParam[] {
  if (statement.namedParameters) {
    return Object.entries(statement.namedParameters).map(([name, value]) => ({
      label: /^[:@$]/.test(name) ? name : `:${name}`,
      value,
    }));
  }

  const prefix = /\$\d/.test(statement.sql) ? "$" : "?";

  return statement.parameters.map((value, index) => ({
    label: `${prefix}${index + 1}`,
    value,
  }));
}
