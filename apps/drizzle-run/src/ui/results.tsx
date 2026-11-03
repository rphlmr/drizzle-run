import type { SerializedValue, SqlEvent } from "@drizzle-run/core/contracts";
import type { DisplayChange } from "@drizzle-run/core/guide";
import { isEqual } from "es-toolkit";
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  BracesIcon,
  BracketsIcon,
  ChevronDownIcon,
  ChevronUpIcon,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { cn } from "../lib/utils";
import { useCopyFeedback } from "./clipboard";
import { getSizeLabel, getTableColumns, getTableRows, type TableColumn } from "./json-tree";
import { JsonTree } from "./json-tree-view";
import { SqlTokens } from "./sql-block";
import { formatSql } from "./sql-highlight";
import { PHONE_QUERY, useMediaQuery } from "./use-media-query";

type ObjectValue = Extract<SerializedValue, { type: "object" }>;

const structuredClass = cn("pl-[15px]");

/** The dashed placeholder of an output view with nothing to show. */
export function OutputEmpty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-40 flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-6 text-center">
      <p className="max-w-70 font-medium">{title}</p>
      <p className="max-w-70 text-muted">{children}</p>
    </div>
  );
}

/** Saves the value as a pretty-printed JSON file. */
export function download(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");

  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Draws one serialized value as text, or `[]` for an empty array. */
export function Value({ value }: { value: SerializedValue }) {
  if (value.type === "array" && value.value.length === 0) {
    return <span className="text-muted">[]</span>;
  }

  if (value.type === "array") {
    return (
      <ol className={structuredClass}>
        {value.value.map((item, index) => (
          <li key={index}>
            <Value value={item} />
          </li>
        ))}
      </ol>
    );
  }

  if (value.type === "object") {
    return (
      <dl className={structuredClass}>
        {Object.entries(value.value).map(([key, item]) => (
          <div key={key}>
            <dt className="font-semibold">{key}</dt>
            <dd className="mt-0.75 mb-2.25 ml-4">
              <Value value={item} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  if (value.type === "undefined") {
    return <span className="text-muted">undefined</span>;
  }

  if (value.type === "circular") {
    return <span>↻ {value.path}</span>;
  }

  if (value.type === "unsupported") {
    return (
      <span>
        {value.valueType}: {value.description}
      </span>
    );
  }

  return <span>{value.value === null ? "null" : String(value.value)}</span>;
}

/** Where a table's chips open their value: the switch to the JSON view and the phone layout. */
interface TableContext {
  phone: boolean;
  /** Opens the value at this path (keys and indexes from the result's root) in the JSON view. */
  openInJson(path: readonly string[]): void;
}

/** A column name with its faint `many` or `one` relation hint. */
function ColumnName({ column }: { column: TableColumn }) {
  return (
    <>
      {column.name}
      {column.hint && (
        <>
          {" "}
          <span className="font-normal text-faint">{column.hint}</span>
        </>
      )}
    </>
  );
}

/** A relation past NESTED_TABLE_DEPTH: its size, drawn at 22px with a 44px hit area, opening it in the JSON view. */
function JsonChip({
  name,
  value,
  path,
  context,
}: {
  name: string;
  value: Extract<SerializedValue, { type: "array" | "object" }>;
  path: readonly string[];
  context: TableContext;
}) {
  const size = getSizeLabel(value);
  const Icon = value.type === "array" ? BracketsIcon : BracesIcon;

  return (
    <button
      type="button"
      className="relative inline-flex h-5.5 items-center gap-1.25 rounded-[6px] border border-border bg-surface px-1.75 font-mono text-[11px] leading-none font-medium whitespace-nowrap text-text after:absolute after:top-1/2 after:left-1/2 after:h-11 after:w-[max(100%,44px)] after:-translate-1/2 hover:border-accent-text hover:bg-mark max-phone:h-6 max-phone:px-1.5 [&_svg]:size-2.75"
      aria-label={`Open ${name} in JSON, ${size}`}
      onClick={() => context.openInJson(path)}
    >
      <Icon aria-hidden="true" />
      {size}
      <ArrowUpRightIcon aria-hidden="true" />
    </button>
  );
}

/**
 * Where a table's rows sit in the result: the table's own path, and whether it is an array whose rows add their index.
 */
interface RowSource {
  path: readonly string[];
  array: boolean;
}

/** The path of one row, then of one of its cells; an object shown as a single row is its own path. */
function getCellPath({ path, array }: RowSource, index: number, column: TableColumn) {
  return array ? [...path, String(index), column.name] : [...path, column.name];
}

/** A table cell: a relation as a table up to NESTED_TABLE_DEPTH, then as a chip; `[]` for an empty one. */
function CellValue({
  column,
  value,
  level,
  path,
  context,
}: {
  column: TableColumn;
  value: SerializedValue | undefined;
  level: number;
  path: readonly string[];
  context: TableContext;
}) {
  if (value === undefined) {
    return null;
  }

  if (value.type === "array" && value.value.length === 0) {
    return <span className="font-mono text-muted">[]</span>;
  }

  const rows = getTableRows(value);

  if (rows === undefined || (value.type !== "array" && value.type !== "object")) {
    return <Value value={value} />;
  }

  if (!column.nested) {
    return <JsonChip name={column.name} value={value} path={path} context={context} />;
  }

  return (
    <NestedTable rows={rows} source={{ path, array: value.type === "array" }} level={level + 1} context={context} />
  );
}

/** The faint label over a relation on phones, where it sits full width under its row. */
function RelationLabel({ column }: { column: TableColumn }) {
  return (
    <span className="block font-mono text-[11px] leading-[1.3] font-medium text-muted">
      <ColumnName column={column} />
    </span>
  );
}

/** A relation inside a cell: its column names once, then a row per object; nested relations go one level deeper. */
function NestedTable({
  rows,
  source,
  level,
  context,
}: {
  rows: readonly ObjectValue[];
  source: RowSource;
  level: number;
  context: TableContext;
}) {
  const columns = getTableColumns(rows, level);
  const plain = context.phone ? columns.filter((column) => !column.nested) : columns;
  const relations = context.phone ? columns.filter((column) => column.nested) : [];
  const head = cn(
    "bg-surface-2 text-left font-mono text-[11px] leading-[1.3] font-medium whitespace-nowrap text-text",
    level > 1 || context.phone ? "px-2 py-1" : "px-2.5 py-1.25",
  );
  const cell = cn("border-t border-border align-top", level > 1 || context.phone ? "px-2 py-1.25" : "px-2.5 py-1.5");

  return (
    <table
      className={cn(
        "w-full border-separate border-spacing-0 overflow-hidden rounded-[8px] border border-border bg-surface whitespace-normal",
        level > 1 ? "text-[12px]" : "text-[12.5px]",
      )}
    >
      {plain.length > 0 && (
        <thead>
          <tr>
            {plain.map((column) => (
              <th key={column.name} className={cn(head, column.fit && "w-[1%]")}>
                <ColumnName column={column} />
              </th>
            ))}
          </tr>
        </thead>
      )}
      <tbody>
        {rows.map((row, index) => (
          <Fragment key={index}>
            {plain.length > 0 && (
              <tr>
                {plain.map((column) => (
                  <td key={column.name} className={cn(cell, column.fit && "w-[1%] whitespace-nowrap")}>
                    <CellValue
                      column={column}
                      value={row.value[column.name]}
                      level={level}
                      path={getCellPath(source, index, column)}
                      context={context}
                    />
                  </td>
                ))}
              </tr>
            )}
            {relations.map((column) => (
              <tr key={column.name}>
                <td
                  colSpan={Math.max(plain.length, 1)}
                  className={cn("align-top", plain.length > 0 ? "pr-2 pb-2 pl-7.5" : "border-t border-border p-2")}
                >
                  <RelationLabel column={column} />
                  <div className="mt-1.5">
                    <CellValue
                      column={column}
                      value={row.value[column.name]}
                      level={level}
                      path={getCellPath(source, index, column)}
                      context={context}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

/** Phone rows with relations: a row's plain values on one line, then each relation full width under it. */
function PhoneRows({
  rows,
  source,
  columns,
  context,
}: {
  rows: readonly ObjectValue[];
  source: RowSource;
  columns: readonly TableColumn[];
  context: TableContext;
}) {
  return (
    <div className="text-[13px]">
      {rows.map((row, index) => (
        <div key={index} className="flex flex-col gap-2 border-t border-border px-3.5 pt-2.5 pb-3 first:border-t-0">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            {columns
              .filter((column) => !column.nested)
              .map((column) => (
                <span key={column.name} className="min-w-0 wrap-anywhere">
                  <CellValue
                    column={column}
                    value={row.value[column.name]}
                    level={0}
                    path={getCellPath(source, index, column)}
                    context={context}
                  />
                </span>
              ))}
          </div>
          {columns
            .filter((column) => column.nested)
            .map((column) => (
              <div key={column.name} className="flex flex-col gap-1.5">
                <RelationLabel column={column} />
                <div>
                  <CellValue
                    column={column}
                    value={row.value[column.name]}
                    level={0}
                    path={getCellPath(source, index, column)}
                    context={context}
                  />
                </div>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

/** A result's own rows start at its root. */
function getRootSource(value: SerializedValue): RowSource {
  return { path: [], array: value.type === "array" };
}

/** "2 rows" when a result holds exactly one array, "1 row" for one object it shows as a table, nothing otherwise. */
function getRowCountLabel(values: readonly SerializedValue[]): string | undefined {
  const [value] = values;

  if (values.length !== 1 || value === undefined) {
    return undefined;
  }

  const count = value.type === "array" ? value.value.length : getTableRows(value)?.length;

  return count === undefined ? undefined : count === 1 ? "1 row" : `${count} rows`;
}

/** "3 columns" when a result holds exactly one table, nothing otherwise. Relations count once, as their column. */
function getColumnCountLabel(values: readonly SerializedValue[]): string | undefined {
  const [value] = values;
  const rows = values.length === 1 && value !== undefined ? getTableRows(value) : undefined;

  if (rows === undefined) {
    return undefined;
  }

  const columns = new Set(rows.flatMap((row) => Object.keys(row.value))).size;

  return columns === 1 ? "1 column" : `${columns} columns`;
}

/** Which value a depth chip opened, and where in it, for the JSON view to reveal. */
interface Reveal {
  index: number;
  path: readonly string[];
}

/** The Table and JSON switch of a result, with the JSON view a depth chip opens. */
function useResultView(values: readonly SerializedValue[]) {
  const [view, setView] = useState<ResultView>("table");
  const [reveal, setReveal] = useState<Reveal>();
  const phone = useMediaQuery(PHONE_QUERY);

  return {
    view,
    reveal,
    switchable: values.some((value) => getTableRows(value) !== undefined),
    choose: (next: ResultView) => {
      setView(next);
      setReveal(undefined);
    },
    context: (index: number): TableContext => ({
      phone,
      openInJson(path) {
        setView("json");
        setReveal({ index, path });
      },
    }),
  };
}

function isContainerValue(value: SerializedValue) {
  return value.type === "array" || value.type === "object";
}

type ResultView = "table" | "json";

const resultViews: Record<ResultView, string> = { table: "Table", json: "JSON" };

function isResultView(key: string): key is ResultView {
  return Object.hasOwn(resultViews, key);
}

function ResultViewToggle({
  view,
  onChange,
  small = false,
  className,
}: {
  view: ResultView;
  onChange: (view: ResultView) => void;
  /** The side-by-side card's 36 px title row. */
  small?: boolean;
  className?: string;
}) {
  return (
    <fieldset
      aria-label="Result view"
      className={cn("flex min-w-auto gap-0.5 rounded-base bg-surface-2 p-0.5", className)}
    >
      {Object.keys(resultViews)
        .filter(isResultView)
        .map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={view === item}
            className={cn(
              "rounded-[6px] border-0 font-medium max-phone:relative max-phone:h-8 max-phone:py-0 max-phone:text-[12px] max-phone:after:absolute max-phone:after:inset-x-0 max-phone:after:-inset-y-1.5",
              small
                ? "relative px-2 py-0.5 text-[11.5px] after:absolute after:inset-x-0 after:-inset-y-1.5"
                : "px-2.5 py-0.75 text-[12.5px]",
              view === item ? "bg-surface text-text shadow-[0_0_0_1px_var(--border)]" : "bg-transparent text-muted",
            )}
            onClick={() => onChange(item)}
          >
            {resultViews[item]}
          </button>
        ))}
    </fieldset>
  );
}

/** Above a value a depth chip opened in JSON: returns to the table it came from. */
function BackToTable({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      className="mb-1.5 flex items-center gap-1 border-0 bg-transparent p-0 text-[12px] font-medium text-accent-text hover:underline"
      onClick={onBack}
    >
      <ArrowLeftIcon className="size-3" aria-hidden="true" />
      Back to table
    </button>
  );
}

function isSameCell(left: SerializedValue | undefined, right: SerializedValue | undefined) {
  return isEqual(left, right);
}

/** A table that fills its card edge to edge, under the card's header. `change` marks new and changed rows. */
function CardTable({
  rows,
  source,
  change,
  context,
  dense = false,
}: {
  rows: readonly ObjectValue[];
  source: RowSource;
  change?: DisplayChange | undefined;
  context: TableContext;
  dense?: boolean;
}) {
  const columns = getTableColumns(rows, 0);
  const nested = columns.some((column) => column.nested);
  // The diff holds the rows of this very result, so they match by identity.
  const earlier = new Map<SerializedValue, SerializedValue>(
    change?.changed.map(({ before, after }) => [after, before]),
  );
  const added = new Set<SerializedValue>(change?.status === "changed" ? change.added : []);

  if (context.phone && nested) {
    return <PhoneRows rows={rows} source={source} columns={columns} context={context} />;
  }

  return (
    <Table className={cn("text-[13.5px]", dense && "font-mono text-[12px]")}>
      <TableHeader>
        <TableRow className="bg-surface-2">
          {columns.map((column) => (
            <TableHead
              key={column.name}
              className={cn(
                "border-b-0 px-4 py-2.25 text-[11.5px] font-semibold whitespace-nowrap text-text",
                dense && "h-auto px-3 py-1.5 font-mono text-[11px]",
                column.fit && "w-[1%]",
              )}
            >
              <ColumnName column={column} />
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => {
          const before = earlier.get(row);
          const marked = before !== undefined || added.has(row);

          return (
            <TableRow
              key={index}
              className={cn("border-t border-border", marked && "bg-mark")}
              data-changed={marked || undefined}
            >
              {columns.map((column) => {
                const value = row.value[column.name];
                const previous = before?.type === "object" ? before.value[column.name] : undefined;
                const cellChanged = before !== undefined && column.hint === undefined && !isSameCell(previous, value);

                return (
                  <TableCell
                    key={column.name}
                    className={cn(
                      "border-b-0 px-4 py-3",
                      dense && "px-3 py-1.75",
                      !column.nested && "whitespace-nowrap",
                      nested && "align-top",
                      column.fit && "w-[1%]",
                    )}
                  >
                    {cellChanged ? (
                      <>
                        <span className="rounded-[4px] bg-lime px-1.25 py-px font-mono font-bold text-on-lime">
                          {value ? <Value value={value} /> : ""}
                        </span>
                        <span className="ml-2.5 font-mono text-faint line-through">
                          <span className="sr-only">was </span>
                          {previous ? <Value value={previous} /> : ""}
                        </span>
                      </>
                    ) : (
                      <CellValue
                        column={column}
                        value={value}
                        level={0}
                        path={getCellPath(source, index, column)}
                        context={context}
                      />
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function formatStatementCount(count: number) {
  return count === 1 ? "1 statement" : `${count} statements`;
}

function formatParamCount(statements: readonly SqlEvent[]): string {
  const count = statements.reduce((total, statement) => total + statement.parameters.length, 0);

  return count === 0 ? "no params" : count === 1 ? "1 param" : `${count} params`;
}

/**
 * The statements' summed duration, such as "0.4 ms"; the screenshot suite hides [data-duration], which changes between
 * runs.
 */
function formatTotalDuration(statements: readonly SqlEvent[]): string | undefined {
  const durations = statements.flatMap((statement) =>
    statement.durationMs === undefined ? [] : [statement.durationMs],
  );

  if (durations.length === 0) {
    return undefined;
  }

  const total = durations.reduce((sum, duration) => sum + duration, 0);

  return total < 10 ? `${total.toFixed(1)} ms` : `${Math.round(total)} ms`;
}

const copyLabels = { copied: "Copied", failed: "Couldn't copy" } as const;

/** The SQL behind a result, folded to one line under the card; its chevron sits left of Copy. */
function ResultSql({ statements, onShowInLogs }: { statements: readonly SqlEvent[]; onShowInLogs?: () => void }) {
  const [open, setOpen] = useState(false);
  const { outcome, copy } = useCopyFeedback();
  const sql = statements.map((statement) => statement.sql).join(";\n");
  const duration = formatTotalDuration(statements);
  const ToggleIcon = open ? ChevronUpIcon : ChevronDownIcon;

  return (
    <div className="border-t border-border bg-surface-2" data-slot="result-sql">
      <div className="flex items-center gap-2.5 py-2 pr-2.5 pl-4">
        <span className="text-[10.5px] font-bold tracking-[0.06em] text-muted">SQL</span>
        {open ? (
          <span className="min-w-0 flex-1 text-[12px] text-muted">
            {formatStatementCount(statements.length)} · {formatParamCount(statements)}
          </span>
        ) : (
          <code className="min-w-0 flex-1 truncate text-[11.5px] text-text">
            <SqlTokens sql={statements.map((statement) => statement.sql.replace(/\s+/g, " ")).join("; ")} />
          </code>
        )}
        {duration && (
          <span className="font-mono text-[11px] text-muted" data-duration="">
            {duration}
          </span>
        )}
        <Button
          variant="outline"
          className="size-6.5 shrink-0 p-0 max-phone:relative max-phone:size-9 max-phone:after:absolute max-phone:after:-inset-1.25 [&_svg]:size-3.25 [&_svg]:stroke-[2.5]"
          aria-expanded={open}
          aria-label={open ? "Collapse SQL" : "Expand SQL"}
          onClick={() => setOpen((current) => !current)}
        >
          <ToggleIcon aria-hidden="true" />
        </Button>
        <Button
          variant="outline"
          className={cn(
            "h-6.5 shrink-0 px-2 text-[12px] max-phone:relative max-phone:h-9 max-phone:px-2.5 max-phone:text-[12.5px] max-phone:after:absolute max-phone:after:-inset-1.25",
            outcome === "failed" && "text-err",
          )}
          onClick={() => copy(sql)}
        >
          {outcome ? copyLabels[outcome] : "Copy"}
        </Button>
        {/* A live region without the status role: the run pill stays the output's only status. */}
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {outcome ? copyLabels[outcome] : ""}
        </span>
      </div>
      {open && (
        <>
          <pre className="overflow-x-auto px-4 pt-0.5 pb-2.5 text-[12px]/5 whitespace-pre text-text">
            <code>
              {statements.map((statement, index) => (
                <span key={index} className="block">
                  <SqlTokens sql={formatSql(statement.sql)} />
                </span>
              ))}
            </code>
          </pre>
          {statements.some((statement) => statement.parameters.length > 0) && (
            <div className="flex flex-wrap items-baseline gap-2 px-4 pb-2.5 font-mono text-[12px]">
              <span className="font-sans text-muted">Params</span>
              {statements
                .flatMap((statement) => statement.parameters)
                .map((value, index) => (
                  <Value key={index} value={value} />
                ))}
            </div>
          )}
          {onShowInLogs && (
            <div className="px-4 pb-3 text-[12px]">
              <button
                type="button"
                className="border-0 bg-transparent p-0 font-semibold text-accent-text underline max-phone:relative max-phone:after:absolute max-phone:after:-inset-x-1 max-phone:after:-inset-y-3.5"
                onClick={onShowInLogs}
              >
                Show in Logs
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Props of a result card: its label, values, source and SQL. */
export interface ResultCardProps {
  /** The display label; the default export has none. */
  label: string | undefined;
  values: readonly SerializedValue[];
  /** Where the result came from, such as a `query.ts:31` link. */
  source?: ReactNode;
  /** The SQL behind the result, shown in the card's footer. */
  statements: readonly SqlEvent[];
  onShowInLogs?: () => void;
  /** How this result differs from an earlier run, such as the step before in a guide. */
  change?: DisplayChange;
  /** Names that earlier run on a changed card, such as "vs step 1". */
  compareLabel?: string;
  /** A side-by-side pane's card: a 36 px title row with its source and switch, then the rows; no SQL footer. */
  compact?: boolean;
  /** A guide step points at this result, such as the one its edit changes: the card scrolls into view. */
  highlighted?: boolean;
}

/** One result on the Results tab: a titled card with its rows, a Table and JSON switch, and the SQL behind it. */
export function ResultCard({
  label,
  values,
  source,
  statements,
  onShowInLogs,
  change,
  compareLabel,
  compact = false,
  highlighted = false,
}: ResultCardProps) {
  const { view, reveal, switchable, choose, context } = useResultView(values);
  const title = label ?? "Default export";
  const meta = [getRowCountLabel(values), getColumnCountLabel(values)].filter((item) => item !== undefined).join(" · ");
  const cardLabel = highlighted ? `${title}, the result this step points at` : title;
  const card = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!highlighted) {
      return;
    }

    const firstHighlighted = card.current?.parentElement?.querySelector("[data-highlighted]");

    if (card.current === null || firstHighlighted !== card.current) {
      return;
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    card.current.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
  }, [highlighted]);

  if (compact) {
    return (
      <section
        className="relative min-w-0 shrink-0 overflow-hidden rounded-[12px] border-[1.5px] border-card-border bg-surface shadow-sticker-card"
        ref={card}
        aria-label={cardLabel}
        data-slot="result-card"
        data-highlighted={highlighted || undefined}
      >
        <header className="flex h-9 items-center gap-2 px-3">
          <h3 className="min-w-0 flex-1 truncate font-display text-[15px] font-[750] tracking-[-0.01em]">{title}</h3>
          <span className="shrink-0 [&_button]:text-[11px]">{source}</span>
          {switchable && <ResultViewToggle view={view} onChange={choose} small />}
        </header>
        {values.map((value, index) => {
          const rows = getTableRows(value);

          return (
            <div key={index} className="overflow-x-auto">
              {view === "json" && isContainerValue(value) ? (
                <div className="border-t border-border px-3 py-2">
                  {reveal?.index === index && <BackToTable onBack={() => choose("table")} />}
                  <JsonTree value={value} reveal={reveal?.index === index ? reveal.path : undefined} />
                </div>
              ) : rows ? (
                <CardTable rows={rows} source={getRootSource(value)} context={context(index)} dense />
              ) : (
                <div className="border-t border-border px-3 py-2 font-mono text-[12px] wrap-anywhere">
                  <Value value={value} />
                </div>
              )}
            </div>
          );
        })}
      </section>
    );
  }

  return (
    <section
      // Relative keeps the Copy announcement inside the output's scroll area, so it cannot give the page a scrollbar.
      className="relative min-w-0 scroll-my-4.5 overflow-hidden rounded-lg border-[1.5px] border-card-border bg-surface shadow-sticker-card max-phone:scroll-my-3.5"
      ref={card}
      aria-label={cardLabel}
      data-slot="result-card"
      data-highlighted={highlighted || undefined}
    >
      <header className="flex items-start gap-3 px-4 pt-4 pb-3 max-phone:gap-2.5 max-phone:px-3.5 max-phone:pt-3.5 max-phone:pb-2.5">
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-[24px] leading-[1.1] font-[750] tracking-[-0.02em] wrap-anywhere max-phone:text-[22px]">
            {title}
          </h3>
          {(meta !== "" || source) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2.5 text-[12px] text-muted max-phone:gap-2">
              {meta !== "" && <span>{meta}</span>}
              {meta !== "" && source && (
                <span className="text-faint" aria-hidden="true">
                  ·
                </span>
              )}
              {source}
            </div>
          )}
        </div>
        {compareLabel && change?.status === "changed" && (
          <span className="inline-flex h-6.5 shrink-0 items-center rounded-pill bg-surface-2 px-2.5 text-[11px] font-semibold whitespace-nowrap text-muted">
            {compareLabel}
          </span>
        )}
        {switchable && <ResultViewToggle view={view} onChange={choose} />}
      </header>
      {values.map((value, index) => {
        const rows = getTableRows(value);

        return (
          <div key={index} className="overflow-x-auto border-t border-border">
            {view === "json" && isContainerValue(value) ? (
              <div className="px-4 py-3">
                {reveal?.index === index && <BackToTable onBack={() => choose("table")} />}
                <JsonTree value={value} reveal={reveal?.index === index ? reveal.path : undefined} />
              </div>
            ) : rows ? (
              <CardTable rows={rows} source={getRootSource(value)} change={change} context={context(index)} />
            ) : (
              <div className="px-4 py-3 font-mono text-[13px] wrap-anywhere">
                <Value value={value} />
              </div>
            )}
          </div>
        );
      })}
      {statements.length > 0 && <ResultSql statements={statements} onShowInLogs={onShowInLogs} />}
    </section>
  );
}

/** The Results filter after a run that displayed nothing. */
export function ResultsEmpty() {
  return (
    <OutputEmpty title="Nothing displayed">
      Use <code>$.display("Users", rows)</code> to add a labelled result.
    </OutputEmpty>
  );
}
