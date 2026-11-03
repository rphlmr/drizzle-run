import type { SerializedValue } from "@drizzle-run/core/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";

import { cn } from "../lib/utils";
import { getSizeLabel, toJsonLiteral } from "./json-tree";

type Container = Extract<SerializedValue, { type: "array" | "object" }>;

function isContainer(value: SerializedValue): value is Container {
  return (
    (value.type === "array" && value.value.length > 0) ||
    (value.type === "object" && Object.keys(value.value).length > 0)
  );
}

function getLeafTone(value: SerializedValue): string {
  if (value.type === "date" || (value.type === "primitive" && typeof value.value === "string")) {
    return "text-c-str";
  }

  return value.type === "bigint" || (value.type === "primitive" && value.value !== null) ? "text-c-fn" : "text-muted";
}

function getIndentStyle(depth: number, chevron = false) {
  return { paddingLeft: `${depth * 18 + 4 + (chevron ? 14 : 0)}px` };
}

const toggleClass = cn("inline-flex items-center gap-1 border-0 bg-transparent p-0 text-left font-mono");
/** A folded object previews this many fields on its line. */
const previewFields = 4;

/** Children of an array or object, one line each, with the label a fold button announces. */
function listChildren(value: Container, depth: number) {
  return value.type === "array"
    ? value.value.map((item, index) => ({
        id: String(index),
        name: undefined,
        label: `${depth === 0 ? "row" : "item"} ${index + 1}`,
        value: item,
      }))
    : Object.entries(value.value).map(([key, item]) => ({ id: key, name: key, label: key, value: item }));
}

/** A nested container's size inside a folded line. */
function Size({ value }: { value: Container }) {
  return (
    <span className="rounded-[5px] border border-border px-1.25 text-[11.5px] text-muted">{getSizeLabel(value)}</span>
  );
}

/** A folded line: an array's size, or an object's first fields with nested values as their size. */
function Folded({ value }: { value: Container }) {
  if (value.type === "array") {
    return <Size value={value} />;
  }

  const entries = Object.entries(value.value);

  return (
    <span className="text-muted">
      {"{ "}
      {entries.slice(0, previewFields).map(([key, item], index) => (
        <Fragment key={key}>
          {index > 0 && ", "}
          <span className="text-text">{JSON.stringify(key)}</span>:{" "}
          {isContainer(item) ? <Size value={item} /> : <span className={getLeafTone(item)}>{toJsonLiteral(item)}</span>}
        </Fragment>
      ))}
      {entries.length > previewFields && ", …"}
      {" }"}
    </span>
  );
}

/**
 * A value as foldable JSON. It opens two levels, the rows and their relations, and folds deeper values to their size.
 * `reveal` is the path of keys and indexes to one value, such as `["0", "posts", "1"]`: it opens that value and
 * focuses it.
 */
export function JsonTree({ value, reveal }: { value: SerializedValue; reveal?: readonly string[] }) {
  if (!isContainer(value)) {
    return (
      <div className="rounded-md border border-border px-3 py-2.5 font-mono text-[12.5px]/[1.75]">
        <span className={getLeafTone(value)}>{toJsonLiteral(value)}</span>
      </div>
    );
  }

  const [open, close] = value.type === "array" ? ["[", "]"] : ["{", "}"];
  const children = listChildren(value, 0);
  const openDepth = value.type === "array" ? 2 : 1;

  return (
    <div className="overflow-auto rounded-md border border-border px-3 py-2.5 font-mono text-[12.5px]/[1.75] [&_svg]:size-2.5">
      <div className="text-muted">{open}</div>
      {children.map((child, index) => (
        <JsonNode
          key={child.id}
          name={child.name}
          label={child.label}
          value={child.value}
          depth={1}
          openDepth={openDepth}
          last={index === children.length - 1}
          reveal={reveal?.[0] === child.id ? reveal.slice(1) : undefined}
        />
      ))}
      <div className="text-muted">{close}</div>
    </div>
  );
}

interface JsonNodeProps {
  name: string | undefined;
  label: string;
  value: SerializedValue;
  depth: number;
  openDepth: number;
  last: boolean;
  /** The rest of the path to the revealed value when this node is on it; empty when this node is that value. */
  reveal: readonly string[] | undefined;
}

function JsonNode({ name, label, value, depth, openDepth, last, reveal }: JsonNodeProps) {
  const [open, setOpen] = useState(reveal !== undefined || depth <= openDepth);
  const target = reveal?.length === 0;
  const toggle = useRef<HTMLButtonElement>(null);
  const comma = last ? "" : ",";
  const key =
    name === undefined ? null : (
      <>
        <span className="text-text">{JSON.stringify(name)}</span>
        <span className="text-muted">: </span>
      </>
    );
  const line = cn("whitespace-nowrap", target && "rounded-[4px] bg-mark");

  useEffect(() => {
    if (target) {
      toggle.current?.focus({ preventScroll: true });
      toggle.current?.scrollIntoView({ block: "nearest" });
    }
  }, [target]);

  if (!isContainer(value)) {
    return (
      <div className={line} style={getIndentStyle(depth)}>
        {key}
        <span className={getLeafTone(value)}>{toJsonLiteral(value)}</span>
        <span className="text-muted">{comma}</span>
      </div>
    );
  }

  if (!open) {
    return (
      <div className={line} style={getIndentStyle(depth)}>
        <button
          ref={toggle}
          type="button"
          className={cn(toggleClass, "text-text")}
          aria-expanded={false}
          onClick={() => setOpen(true)}
        >
          <ChevronRightIcon aria-hidden="true" className="text-muted" />
          <span>
            {key}
            <Folded value={value} />
          </span>
        </button>
        <span className="text-muted">{comma}</span>
      </div>
    );
  }

  const [opening, closing] = value.type === "array" ? ["[", "]"] : ["{", "}"];
  const children = listChildren(value, depth);

  return (
    <>
      <div className={line} style={getIndentStyle(depth)}>
        <button
          ref={toggle}
          type="button"
          className={cn(toggleClass, "text-muted")}
          aria-expanded={true}
          aria-label={`Collapse ${label}`}
          onClick={() => setOpen(false)}
        >
          <ChevronDownIcon aria-hidden="true" />
          <span>
            {key}
            {opening}
          </span>
        </button>
      </div>
      {children.map((child, index) => (
        <JsonNode
          key={child.id}
          name={child.name}
          label={child.label}
          value={child.value}
          depth={depth + 1}
          openDepth={openDepth}
          last={index === children.length - 1}
          reveal={reveal?.[0] === child.id ? reveal.slice(1) : undefined}
        />
      ))}
      <div className="text-muted" style={getIndentStyle(depth, true)}>
        {closing}
        {comma}
      </div>
    </>
  );
}
