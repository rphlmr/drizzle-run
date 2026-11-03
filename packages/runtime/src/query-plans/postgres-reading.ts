import type { QueryPlanReading } from "@drizzle-run/core/contracts";
import { lowerFirst, sumBy, uniq } from "es-toolkit";
import * as z from "zod/mini";

import { addCandidate, findTable, isUnindexedForeignKey, type IndexCandidate, type PlanTable } from "./schema.ts";
import { formatRows } from "./sizes.ts";
import { columnReferences, mustReadWholeTables } from "./sql-text.ts";
import type { PlanStep } from "./steps.ts";

/** One node of `EXPLAIN (FORMAT JSON)`; only the fields Drizzle Run reads are named. */
export interface PostgresPlanNode {
  "Node Type": string;
  "Total Cost": number;
  "Startup Cost"?: number;
  "Plan Rows"?: number;
  "Relation Name"?: string;
  Schema?: string;
  Alias?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Recheck Cond"?: string;
  Filter?: string;
  "Hash Cond"?: string;
  "Merge Cond"?: string;
  "Join Filter"?: string;
  "Join Type"?: string;
  "Sort Key"?: string[];
  "Group Key"?: string[];
  Strategy?: string;
  Operation?: string;
  "Actual Rows"?: number;
  "Actual Total Time"?: number;
  "Actual Loops"?: number;
  "Sort Space Type"?: string;
  "Disk Usage"?: number;
  "Hash Batches"?: number;
  Plans?: PostgresPlanNode[];
}

/** A plan node with the fields Drizzle Run reads; Postgres sends many more, which are dropped. */
const PostgresPlanNodeSchema: z.ZodMiniType<PostgresPlanNode> = z.object({
  "Node Type": z.string(),
  "Total Cost": z.number(),
  "Startup Cost": z.optional(z.number()),
  "Plan Rows": z.optional(z.number()),
  "Relation Name": z.optional(z.string()),
  Schema: z.optional(z.string()),
  Alias: z.optional(z.string()),
  "Index Name": z.optional(z.string()),
  "Index Cond": z.optional(z.string()),
  "Recheck Cond": z.optional(z.string()),
  Filter: z.optional(z.string()),
  "Hash Cond": z.optional(z.string()),
  "Merge Cond": z.optional(z.string()),
  "Join Filter": z.optional(z.string()),
  "Join Type": z.optional(z.string()),
  "Sort Key": z.optional(z.array(z.string())),
  "Group Key": z.optional(z.array(z.string())),
  Strategy: z.optional(z.string()),
  Operation: z.optional(z.string()),
  "Actual Rows": z.optional(z.number()),
  "Actual Total Time": z.optional(z.number()),
  "Actual Loops": z.optional(z.number()),
  "Sort Space Type": z.optional(z.string()),
  "Disk Usage": z.optional(z.number()),
  "Hash Batches": z.optional(z.number()),
  Plans: z.optional(z.array(z.lazy(() => PostgresPlanNodeSchema))),
});

/** `EXPLAIN (FORMAT JSON)` output: a list whose first entry holds the root node. */
const PostgresExplainSchema = z.tuple([z.object({ Plan: PostgresPlanNodeSchema })], z.unknown());

/** Parse `EXPLAIN (FORMAT JSON)` output to its root node; throws a `TypeError` when it has no readable plan. */
export function parsePostgresPlan(json: string): PostgresPlanNode {
  const explained = PostgresExplainSchema.safeParse(JSON.parse(json));

  if (!explained.success) {
    throw new TypeError("Postgres returned a plan Drizzle Run cannot read");
  }

  return explained.data[0].Plan;
}

/** The root node's total cost of an `EXPLAIN (FORMAT JSON)` output */
export function postgresTotalCost(json: string): number {
  return parsePostgresPlan(json)["Total Cost"];
}

/** True when any node of the plan uses the named index */
export function postgresUsesIndex(json: string, name: string): boolean {
  return getPlanNodes(parsePostgresPlan(json)).some(({ node }) => node["Index Name"] === name);
}

/** The plan as steps, each with its own share of the total cost (its cost minus its children's). */
export function postgresSteps(json: string): PlanStep[] {
  const root = parsePostgresPlan(json);
  const total = root["Total Cost"];

  return getPlanNodes(root).map(({ node, depth }) => {
    const childCost = sumBy(node.Plans ?? [], (child) => child["Total Cost"]);
    const own = Math.max(0, node["Total Cost"] - childCost);
    const step: PlanStep = {
      depth,
      label: getNodeLabel(node),
      operation: getNodeOperation(node),
      cost: node["Total Cost"],
      shareOfCost: total > 0 ? own / total : 0,
    };

    if (node["Relation Name"] !== undefined) {
      step.relation = node["Relation Name"];
    }

    if (node["Index Name"] !== undefined) {
      step.index = node["Index Name"];
    }

    const detail = resolveNodeDetail(node);

    if (detail !== undefined) {
      step.detail = detail;
    }

    if (node["Plan Rows"] !== undefined) {
      step.rows = node["Plan Rows"];
    }

    if (node["Actual Rows"] !== undefined) {
      step.actualRows = node["Actual Rows"] * (node["Actual Loops"] ?? 1);
    }

    if (node["Actual Total Time"] !== undefined) {
      step.actualMs = node["Actual Total Time"];
    }

    return step;
  });
}

interface Access {
  node: PostgresPlanNode;
  table: PlanTable | undefined;
  name: string;
  alias: string;
  kind: "full_scan" | "index_full_scan" | "index_lookup" | "first_rows";
}

/**
 * Drizzle Run's reading of one Postgres plan: a sentence, the verdict, and the index tries the plan
 * calls for. `analyzeJson` only adds what `EXPLAIN ANALYZE` saw, such as a sort spilling to disk.
 */
export function readPostgresPlan(input: {
  json: string;
  analyzeJson?: string;
  sql: string;
  tables: readonly PlanTable[];
  tableRows: ReadonlyMap<PlanTable, number>;
}): Omit<QueryPlanReading, "indexes"> & { candidates: IndexCandidate[] } {
  const root = parsePostgresPlan(input.json);
  const accesses = collectAccesses(root, input.tables);
  const growingTables = uniq(
    accesses
      .filter((access) => access.kind === "full_scan" || access.kind === "index_full_scan")
      .map((access) => access.name),
  );
  const verdict: QueryPlanReading["verdict"] =
    growingTables.length === 0 ? { kind: "stays_fast" } : { kind: "grows", tables: growingTables };
  const spillsToDisk =
    input.analyzeJson === undefined
      ? false
      : getPlanNodes(parsePostgresPlan(input.analyzeJson)).some(
          ({ node }) =>
            node["Sort Space Type"] === "Disk" || (node["Disk Usage"] ?? 0) > 0 || (node["Hash Batches"] ?? 1) > 1,
        );
  const summary = `${getSummary(root, accesses, input.tableRows)}${spillsToDisk ? ", and spills to disk" : ""}`;
  // A query that reads every row gains nothing from an index, except where a subquery scans a table once per outer
  // row, as the relational API's nested `with` does.
  const candidates = getIndexCandidates(root, accesses, { correlatedOnly: mustReadWholeTables(input.sql) });

  return { summary, verdict, candidates };
}

/** Nodes that pass rows up one at a time, so a Limit above them still stops the scan below early. */
const STREAMING_NODE_TYPES = new Set([
  "Result",
  "Subquery Scan",
  "Append",
  "Merge Append",
  "Unique",
  "ProjectSet",
  "Nested Loop",
  "Merge Join",
  "Gather",
  "Gather Merge",
  "Limit",
]);

function getAccessKind(node: PostgresPlanNode, isFirstRows: boolean): Access["kind"] {
  const type = node["Node Type"];

  if (node["Index Cond"] !== undefined || type === "Bitmap Heap Scan") {
    return "index_lookup";
  }

  if (isFirstRows && node.Filter === undefined) {
    return "first_rows";
  }

  return /Index/.test(type) ? "index_full_scan" : "full_scan";
}

function collectAccesses(root: PostgresPlanNode, tables: readonly PlanTable[]): Access[] {
  const accesses: Access[] = [];

  // `firstRows` is true while a Limit above can stop reading early: nothing in between needs every row.
  const visitNode = (node: PostgresPlanNode, isFirstRows: boolean) => {
    const type = node["Node Type"];
    const relation = node["Relation Name"];

    if (relation !== undefined && type.endsWith("Scan") && type !== "Subquery Scan" && type !== "CTE Scan") {
      accesses.push({
        node,
        table: findTable(tables, relation, node.Schema),
        name: relation,
        alias: node.Alias ?? relation,
        kind: getAccessKind(node, isFirstRows),
      });
    }

    const children = node.Plans ?? [];

    for (const [index, child] of children.entries()) {
      const isStreaming =
        type === "Limit" ||
        (isFirstRows && STREAMING_NODE_TYPES.has(type) && (type !== "Nested Loop" || index === 0)) ||
        (isFirstRows && type === "Hash Join" && index === 0);
      visitNode(child, isStreaming);
    }
  };

  visitNode(root, false);

  return accesses;
}

function getSummary(root: PostgresPlanNode, accesses: Access[], tableRows: ReadonlyMap<PlanTable, number>): string {
  const write = getPlanNodes(root).find(({ node }) => node["Node Type"] === "ModifyTable")?.node;
  const returnedRows = root["Plan Rows"] ?? 0;
  const getTableRows = (access: Access) => (access.table === undefined ? undefined : tableRows.get(access.table));
  const getReadsText = (access: Access) => {
    const rows = getTableRows(access);

    return rows === undefined ? "" : `, reads ${formatRows(rows)} rows`;
  };
  const isSorted = getPlanNodes(root).some(
    ({ node }) => node["Node Type"] === "Sort" || node["Node Type"] === "Incremental Sort",
  );
  const isGrouped = getPlanNodes(root).some(
    ({ node }) => node["Node Type"] === "Aggregate" && node["Group Key"] !== undefined,
  );
  let sentence: string;

  if (accesses.length === 0) {
    sentence =
      write === undefined ? "Computes its result without reading a table" : "Writes without reading a table first";
  } else if (accesses.length === 1) {
    const [access] = accesses;

    switch (access.kind) {
      case "full_scan":
        sentence = `Full scan of ${access.name}${getReadsText(access)}`;
        break;

      case "index_full_scan":
        const indexName = access.node["Index Name"] ?? "an index";
        sentence = `Reads all of ${access.name} through ${indexName}${getReadsText(access)}`;
        break;

      case "first_rows":
        sentence = `Reads the first rows of ${access.name} and stops`;
        break;

      case "index_lookup":
        sentence = `Index lookup on ${access.name} using ${access.node["Index Name"] ?? "an index"}`;
    }
  } else {
    const join = getPlanNodes(root).find(({ node }) => /Join|Nested Loop/.test(node["Node Type"]))?.node;
    const joinName =
      join === undefined
        ? "Combines"
        : join["Node Type"] === "Nested Loop"
          ? "Nested loop join"
          : join["Node Type"].replace(/ Join$/, " join");
    const scanned = uniq(
      accesses
        .filter((access) => access.kind === "full_scan" || access.kind === "index_full_scan")
        .map((access) => access.name),
    );
    const names = uniq(accesses.map((access) => access.name));
    const scannedText = scanned.length === names.length && names.length === 2 ? "both" : toListText(scanned);
    sentence = `${joinName} over ${toListText(names)}`;
    sentence += scanned.length === 0 ? " by index lookups" : `, full scan of ${scannedText}`;
  }

  if (write !== undefined) {
    const writeVerbs: Record<string, string> = {
      Insert: "Inserts into",
      Update: "Updates",
      Delete: "Deletes from",
      Merge: "Merges into",
    };
    const verb = writeVerbs[write.Operation ?? ""] ?? "Writes to";
    const target = write["Relation Name"] ?? "the table";

    return accesses.length === 0 ? `${verb} ${target}` : `${verb} ${target}; ${lowerFirst(sentence)}`;
  }

  if (isSorted && accesses.some((access) => access.kind === "full_scan")) {
    sentence += ", sorts every row";
  }

  if (isGrouped) {
    sentence += ", then groups";
  }

  return `${sentence} to return ${formatRows(returnedRows)} ${returnedRows === 1 ? "row" : "rows"}`;
}

/**
 * Index candidates of a plan
 *
 * `correlatedOnly` keeps only scans filtered on another table's column, which run once per row of that table.
 */
function getIndexCandidates(
  root: PostgresPlanNode,
  accesses: Access[],
  { correlatedOnly }: { correlatedOnly: boolean },
): IndexCandidate[] {
  const candidates: IndexCandidate[] = [];
  const scanned = accesses.filter((access) => access.kind === "full_scan" && access.table !== undefined);
  const findScannedAccess = (alias: string | undefined, column: string) =>
    scanned.find(
      (access) =>
        (alias === undefined || access.alias === alias || access.name === alias) &&
        access.table?.columns.includes(column),
    );

  for (const access of scanned) {
    const table = access.table;

    if (table === undefined || access.node.Filter === undefined) {
      continue;
    }

    const references = columnReferences(access.node.Filter);
    const isOwnQualifier = (qualifier: string | undefined) =>
      qualifier === undefined || qualifier === access.alias || qualifier === access.name;
    const isCorrelated = references.some(
      ([qualifier]) => !isOwnQualifier(qualifier) && accesses.some((other) => other.alias === qualifier),
    );

    if (correlatedOnly && !isCorrelated) {
      continue;
    }

    for (const [qualifier, column] of references) {
      if (isOwnQualifier(qualifier) && table.columns.includes(column)) {
        addCandidate(candidates, { trigger: "filtered_scan", table, columns: [column] });
      }
    }
  }

  if (correlatedOnly) {
    return candidates;
  }

  for (const { node } of getPlanNodes(root)) {
    for (const condition of [node["Hash Cond"], node["Merge Cond"], node["Join Filter"]]) {
      if (condition === undefined) {
        continue;
      }

      for (const [qualifier, column] of columnReferences(condition)) {
        const access = findScannedAccess(qualifier, column);

        if (access?.table !== undefined && isUnindexedForeignKey(access.table, [column])) {
          addCandidate(candidates, { trigger: "foreign_key_join", table: access.table, columns: [column] });
        }
      }
    }

    if (node["Node Type"] !== "Limit") {
      continue;
    }

    const sort = (node.Plans ?? [])
      .map(skipPassThrough)
      .find((child) => child["Node Type"] === "Sort" || child["Node Type"] === "Incremental Sort");
    const below = sort === undefined ? [] : collectAccesses(sort, []).map((found) => found.node);
    const target = scanned.find((access) => below.includes(access.node));

    if (sort?.["Sort Key"] === undefined || target?.table === undefined) {
      continue;
    }

    const columns = sort["Sort Key"].flatMap((key) => {
      const [reference] = columnReferences(key.replace(/\b(?:DESC|ASC|NULLS FIRST|NULLS LAST)\b/gi, ""));

      return reference !== undefined && target.table?.columns.includes(reference[1]) ? [reference[1]] : [];
    });

    if (columns.length === sort["Sort Key"].length) {
      addCandidate(candidates, { trigger: "sorted_limit", table: target.table, columns });
    }
  }

  return candidates;
}

function skipPassThrough(node: PostgresPlanNode): PostgresPlanNode {
  return (node["Node Type"] === "Gather Merge" || node["Node Type"] === "Result") && node.Plans?.[0] !== undefined
    ? skipPassThrough(node.Plans[0])
    : node;
}

function getPlanNodes(root: PostgresPlanNode): { node: PostgresPlanNode; depth: number }[] {
  const nodes: { node: PostgresPlanNode; depth: number }[] = [];
  const visitNode = (node: PostgresPlanNode, depth: number) => {
    nodes.push({ node, depth });

    for (const child of node.Plans ?? []) {
      visitNode(child, depth + 1);
    }
  };

  visitNode(root, 0);

  return nodes;
}

function getNodeLabel(node: PostgresPlanNode): string {
  const relation = node["Relation Name"] === undefined ? "" : ` ${node["Relation Name"]}`;
  const index = node["Index Name"] === undefined ? "" : ` using ${node["Index Name"]}`;

  return `${getNodeOperation(node)}${relation}${index}`;
}

function getNodeOperation(node: PostgresPlanNode): string {
  if (node["Node Type"] === "Aggregate") {
    const aggregateOperations: Record<string, string> = {
      Hashed: "HashAggregate",
      Sorted: "GroupAggregate",
      Mixed: "MixedAggregate",
    };

    return aggregateOperations[node.Strategy ?? ""] ?? "Aggregate";
  }

  if (node["Node Type"] === "ModifyTable") {
    return node.Operation ?? "ModifyTable";
  }

  if (node["Join Type"] !== undefined && node["Join Type"] !== "Inner" && /Join|Nested Loop/.test(node["Node Type"])) {
    return `${node["Node Type"].replace(/ Join$/, "")} ${node["Join Type"]} Join`;
  }

  return node["Node Type"];
}

function resolveNodeDetail(node: PostgresPlanNode): string | undefined {
  const condition =
    node["Index Cond"] ??
    node["Hash Cond"] ??
    node["Merge Cond"] ??
    node["Recheck Cond"] ??
    node.Filter ??
    node["Join Filter"];

  if (condition !== undefined) {
    return condition.replace(/^\((.*)\)$/, "$1");
  }

  if (node["Sort Key"] !== undefined) {
    return `by ${node["Sort Key"].join(", ")}`;
  }

  if (node["Group Key"] !== undefined) {
    return `by ${node["Group Key"].join(", ")}`;
  }

  return undefined;
}

function toListText(values: readonly string[]): string {
  return values.length <= 1 ? values.join("") : `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}
