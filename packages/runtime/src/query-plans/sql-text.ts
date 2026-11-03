/**
 * Light reading of the statement text, for what a plan does not say (SQLite prints no filters) and to
 * tell queries that must read whole tables apart. Strings and parenthesized parts are masked with
 * spaces so top-level keywords keep their positions in the original text.
 */
export function maskNested(sql: string): string {
  let masked = "";
  let depth = 0;
  let quote: string | undefined;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];

    if (quote !== undefined) {
      masked += " ";

      if (character === quote && sql[index + 1] === quote) {
        masked += " ";
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }

      continue;
    }

    if (character === "'" || (character === '"' && depth > 0) || character === "`") {
      quote = character;
      masked += " ";
      continue;
    }

    if (character === '"') {
      // Top-level identifiers stay readable; only their content could look like a keyword.
      const end = sql.indexOf('"', index + 1);
      const stop = end === -1 ? sql.length - 1 : end;
      masked += `"${" ".repeat(Math.max(0, stop - index - 1))}${end === -1 ? "" : '"'}`;
      index = stop;
      continue;
    }

    if (character === "(") {
      depth += 1;
      masked += depth === 1 ? "(" : " ";
      continue;
    }

    if (character === ")") {
      depth = Math.max(0, depth - 1);
      masked += depth === 0 ? ")" : " ";
      continue;
    }

    masked += depth > 0 ? " " : character;
  }

  return masked;
}

const CLAUSE_END =
  /\b(?:group\s+by|order\s+by|limit|offset|having|returning|window|union|intersect|except|for\s+update|on\s+conflict)\b/i;

/** The text of a top-level clause, such as the expression after `where`, from the original statement. */
export function topLevelClause(sql: string, keyword: "where" | "order by"): string | undefined {
  const masked = maskNested(sql);
  const pattern = keyword === "where" ? /\bwhere\b/i : /\border\s+by\b/i;
  const match = pattern.exec(masked);

  if (match === null) {
    return undefined;
  }

  const start = match.index + match[0].length;
  const end = CLAUSE_END.exec(masked.slice(start));

  return sql.slice(start, end === null ? sql.length : start + end.index).trim();
}

/** True when the keyword appears at the top level of the statement, outside strings and parentheses. */
export function hasTopLevel(sql: string, keyword: "where" | "limit" | "group by" | "distinct"): boolean {
  const masked = maskNested(sql);
  const pattern = {
    where: /\bwhere\b/i,
    limit: /\blimit\b/i,
    "group by": /\bgroup\s+by\b/i,
    distinct: /\bselect\s+distinct\b/i,
  }[keyword];

  return pattern.test(masked);
}

const AGGREGATES =
  /\b(?:count|sum|avg|min|max|total|group_concat|string_agg|array_agg|json_agg|jsonb_agg|json_group_array|json_group_object|bool_and|bool_or|every)\s*\(/i;

/** An aggregate in the select list, such as `count(*)`, so the query reads every matching row. */
export function hasTopLevelAggregate(sql: string): boolean {
  const masked = maskNested(sql);
  const from = /\bfrom\b/i.exec(masked);
  const selectList = sql.slice(0, from === null ? sql.length : from.index);

  return AGGREGATES.test(selectList);
}

/**
 * A query with neither a filter nor a limit has to read whole tables: an index cannot make it read
 * fewer rows, so Drizzle Run tries none for it.
 */
export function mustReadWholeTables(sql: string): boolean {
  return !hasTopLevel(sql, "where") && !hasTopLevel(sql, "limit");
}

/** Column references in an expression, as `[qualifier, column]` with the qualifier when one was written. */
export function columnReferences(expression: string): [string | undefined, string][] {
  const withoutStrings = expression.replace(/'(?:[^']|'')*'/g, "''");
  const references: [string | undefined, string][] = [];
  const pattern = /(?:("(?:[^"]|"")+"|[A-Za-z_][\w$]*)\s*\.\s*)?("(?:[^"]|"")+"|[A-Za-z_][\w$]*)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(withoutStrings)) !== null) {
    if (withoutStrings.slice(Math.max(0, match.index - 2), match.index) === "::") {
      continue;
    }

    references.push([match[1] === undefined ? undefined : unquote(match[1]), unquote(match[2])]);
  }

  return references;
}

/** The columns an `order by` sorts on, in order, without direction. */
export function orderByColumns(sql: string): [string | undefined, string][] {
  const clause = topLevelClause(sql, "order by");

  if (clause === undefined) {
    return [];
  }

  return splitTopLevel(clause).flatMap((item) => {
    const column = item.replace(/\b(?:asc|desc|nulls\s+first|nulls\s+last|collate\s+\S+)\b/gi, "");
    const [reference] = columnReferences(column);

    return reference === undefined ? [] : [reference];
  });
}

/** Split text on its top-level commas, ignoring those inside strings and parentheses, and drop empty parts. */
export function splitTopLevel(text: string): string[] {
  const masked = maskNested(text);
  const parts: string[] = [];
  let start = 0;

  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] === ",") {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }

  parts.push(text.slice(start).trim());

  return parts.filter(Boolean);
}

/** Remove the double quotes around an identifier and unescape its doubled quotes; bare identifiers are kept. */
export function unquote(identifier: string): string {
  return identifier.startsWith('"') && identifier.endsWith('"')
    ? identifier.slice(1, -1).replaceAll('""', '"')
    : identifier;
}

/** Quote an identifier with double quotes, doubling the quotes it contains. */
export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
