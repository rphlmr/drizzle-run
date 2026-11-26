import type { SerializedValue, SqlEvent } from "@drizzle-run/core/contracts";

import { cn } from "../lib/utils";
import { getStatementParams } from "./result-sql";

/** A plain preview of a serialized value, such as `2`, `Grace` or `["a"]`. */
function toPreview(value: SerializedValue): unknown {
  switch (value.type) {
    case "array":
      return value.value.map(toPreview);
    case "object":
      return Object.fromEntries(Object.entries(value.value).map(([key, item]) => [key, toPreview(item)]));
    case "primitive":
    case "bigint":
    case "date":
      return value.value;
    case "undefined":
      return undefined;
    case "circular":
      return `↻ ${value.path}`;
    case "unsupported":
      return value.description ? `${value.valueType}: ${value.description}` : value.valueType;
  }
}

/** A bound value as chip text; the chip's border, not quotes, shows where a value with spaces ends. */
function formatParamValue(value: SerializedValue): string {
  const preview = toPreview(value);

  if (typeof preview === "string") {
    return preview;
  }

  return preview === undefined ? "undefined" : JSON.stringify(preview);
}

/** One statement's bound values, each a chip labeled with the placeholder it fills, such as `$1 2`. */
export function StatementParams({ statement, className }: { statement: SqlEvent; className?: string }) {
  const params = getStatementParams(statement);

  if (params.length === 0) {
    return null;
  }

  return (
    <ul className={cn("flex flex-wrap gap-1.5 font-mono text-[11.5px]", className)} aria-label="Params">
      {params.map((param, index) => (
        <li
          key={index}
          className="inline-flex max-w-full items-baseline gap-1 rounded-md border border-border bg-surface-2 px-1.5 py-px"
        >
          <span className="text-muted">{param.label}</span>
          <span className="min-w-0 wrap-break-word text-text">{formatParamValue(param.value)}</span>
        </li>
      ))}
    </ul>
  );
}
