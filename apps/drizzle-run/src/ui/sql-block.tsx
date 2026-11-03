import { useMemo } from "react";

import { tokenizeSql, type SqlTokenKind } from "./sql-highlight";

const tokenColors: Record<Exclude<SqlTokenKind, "space" | "plain">, string> = {
  keyword: "text-c-key",
  string: "text-c-str",
  param: "text-c-fn",
  number: "text-c-fn",
  identifier: "text-text",
  comment: "text-c-com italic",
};

/** SQL with its keywords, strings, and parameters colored, as text nodes. */
export function SqlTokens({ sql }: { sql: string }) {
  const tokens = useMemo(() => tokenizeSql(sql), [sql]);

  return tokens.map((token, index) =>
    token.kind === "space" || token.kind === "plain" ? (
      token.text
    ) : (
      <span key={index} className={tokenColors[token.kind]}>
        {token.text}
      </span>
    ),
  );
}
