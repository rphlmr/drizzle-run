/** The kind of a SQL token, for highlighting. */
export type SqlTokenKind = "keyword" | "string" | "identifier" | "param" | "number" | "comment" | "space" | "plain";

/** A run of SQL text of one kind. */
export interface SqlToken {
  kind: SqlTokenKind;
  text: string;
}

const KEYWORDS = new Set([
  "add",
  "all",
  "alter",
  "and",
  "as",
  "asc",
  "autoincrement",
  "begin",
  "between",
  "by",
  "cascade",
  "case",
  "check",
  "column",
  "commit",
  "conflict",
  "constraint",
  "create",
  "cross",
  "default",
  "delete",
  "desc",
  "distinct",
  "do",
  "drop",
  "else",
  "end",
  "except",
  "exists",
  "false",
  "foreign",
  "from",
  "full",
  "group",
  "having",
  "if",
  "ilike",
  "in",
  "index",
  "inner",
  "insert",
  "intersect",
  "into",
  "is",
  "join",
  "key",
  "left",
  "like",
  "limit",
  "not",
  "nothing",
  "null",
  "offset",
  "on",
  "or",
  "order",
  "outer",
  "pragma",
  "primary",
  "references",
  "returning",
  "right",
  "rollback",
  "schema",
  "select",
  "set",
  "table",
  "then",
  "true",
  "union",
  "unique",
  "update",
  "using",
  "values",
  "when",
  "where",
  "with",
]);

// Order matters: comments and quoted text first so their contents are never read as words.
const RULES: readonly (readonly [SqlTokenKind, RegExp])[] = [
  ["comment", /--[^\n]*|\/\*[\s\S]*?\*\//y],
  ["string", /'(?:[^']|'')*'/y],
  ["identifier", /"(?:[^"]|"")*"|`[^`]*`/y],
  ["param", /\$\d+|\?/y],
  ["number", /\d+(?:\.\d+)?/y],
  ["plain", /[A-Za-z_][\w$]*/y],
  ["space", /\s+/y],
];

/** Splits SQL into highlight tokens; joined back, they give the source text exactly. */
export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;

  while (index < sql.length) {
    let matched: SqlToken | undefined;

    for (const [kind, pattern] of RULES) {
      pattern.lastIndex = index;
      const match = pattern.exec(sql);

      if (match) {
        const text = match[0];
        matched = { kind: kind === "plain" && KEYWORDS.has(text.toLowerCase()) ? "keyword" : kind, text };
        break;
      }
    }

    matched ??= { kind: "plain", text: sql.charAt(index) };
    tokens.push(matched);
    index += matched.text.length;
  }

  return tokens;
}

const CLAUSES = new Set([
  "from",
  "where",
  "join",
  "group",
  "order",
  "having",
  "limit",
  "offset",
  "values",
  "set",
  "returning",
  "union",
]);
const JOIN_MODIFIERS = new Set(["left", "right", "inner", "full", "outer", "cross"]);

function isKeyword(token: SqlToken | undefined, words: ReadonlySet<string>) {
  return token?.kind === "keyword" && words.has(token.text.toLowerCase());
}

/** First token of the clause that ends at `index`: `left outer join` starts at `left`. */
function findClauseStart(tokens: readonly SqlToken[], index: number): number {
  let start = index;

  while (isKeyword(tokens[start - 2], JOIN_MODIFIERS) && tokens[start - 1]?.kind === "space") {
    start -= 2;
  }

  return start;
}

/**
 * Puts each top-level clause of a one-line statement on its own line. SQL that
 * already spans lines (drizzle-kit migrations) is returned unchanged.
 */
export function formatSql(sql: string): string {
  if (sql.includes("\n")) {
    return sql;
  }

  const tokens = tokenizeSql(sql);
  const breaks = new Set<number>();
  let depth = 0;

  for (const [index, token] of tokens.entries()) {
    if (token.kind === "plain" && token.text === "(") {
      depth += 1;
    } else if (token.kind === "plain" && token.text === ")") {
      depth = Math.max(0, depth - 1);
    }

    if (depth === 0 && index > 0 && isKeyword(token, CLAUSES)) {
      const start = token.text.toLowerCase() === "join" ? findClauseStart(tokens, index) : index;

      if (start > 0) {
        breaks.add(start);
      }
    }
  }

  return tokens
    .map((token, index) => {
      if (token.kind === "space" && breaks.has(index + 1)) {
        return "\n";
      }

      return breaks.has(index) && tokens[index - 1]?.kind !== "space" ? `\n${token.text}` : token.text;
    })
    .join("");
}
