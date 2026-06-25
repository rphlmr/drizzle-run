import "@xyflow/react/dist/style.css";

import dagre from "@dagrejs/dagre";
import type { Snapshot as MySqlSnapshot } from "@drizzle-lab/api/mysql/web";
import type { Snapshot as PgSnapshot } from "@drizzle-lab/api/pg/web";
import type { Snapshot as SQLiteSnapshot } from "@drizzle-lab/api/sqlite/web";
import type { Edge, Node } from "@xyflow/react";
import { Position } from "@xyflow/react";

/*
 * Work in progress TODO: refactor and test
 */

export type Snapshot = PgSnapshot | SQLiteSnapshot | MySqlSnapshot;

type CompositePrimaryKeyDefinition =
  | PgSnapshot["tables"][number]["compositePrimaryKeys"][number]
  | SQLiteSnapshot["tables"][number]["compositePrimaryKeys"][number]
  | MySqlSnapshot["tables"][number]["compositePrimaryKeys"][number];
type RelationDefinition =
  | PgSnapshot["tables"][number]["relations"][number]
  | SQLiteSnapshot["tables"][number]["relations"][number]
  | MySqlSnapshot["tables"][number]["relations"][number];
type CheckDefinition =
  | PgSnapshot["tables"][number]["checkConstraints"][number]
  | SQLiteSnapshot["tables"][number]["checkConstraints"][number]
  | MySqlSnapshot["tables"][number]["checkConstraints"][number];
type PolicyDefinition = PgSnapshot["policies"][number];
type UniqueConstraintDefinition =
  | PgSnapshot["tables"][number]["uniqueConstraints"][number]
  | SQLiteSnapshot["tables"][number]["uniqueConstraints"][number]
  | MySqlSnapshot["tables"][number]["uniqueConstraints"][number];
type IndexDefinition =
  | PgSnapshot["tables"][number]["indexes"][number]
  | SQLiteSnapshot["tables"][number]["indexes"][number]
  | MySqlSnapshot["tables"][number]["indexes"][number];
type ForeignKeyDefinition = {
  id: string;
  fkName: string;
  tableFrom: string;
  columnFrom: string;
  columnTo: string;
  tableTo: string;
  onDelete: string | undefined;
  onUpdate: string | undefined;
};

export type TableNodeDefinition = Node<
  {
    name: string;
    description?: string;
    schema?: string;
    columns: Array<{
      name: string;
      description?: string;
      dataType: string;
      isPrimaryKey: boolean;
      isForeignKey: boolean;
      isNotNull: boolean;
      isUnique: boolean;
      default?: string;
      defaultFn?: string;
      enumValues?: string[];
      jsonShape?: string;
      onDelete: string | undefined;
      onUpdate: string | undefined;
    }>;
    isRLSEnabled: boolean;
    provider: PgSnapshot["provider"];
    compositePrimaryKeys: Array<CompositePrimaryKeyDefinition>;
    relations: Array<RelationDefinition>;
    checks: Array<CheckDefinition>;
    policies: PolicyDefinition[];
    foreignKeys: Array<ForeignKeyDefinition>;
    uniqueConstraints: Array<UniqueConstraintDefinition>;
    indexes: Array<IndexDefinition>;
    withExplain?: boolean;
  },
  "table"
>;

export type ViewNodeDefinition = Node<
  {
    name: string;
    schema: string | undefined;
    definition: string | undefined;
    description: string | undefined;
    columns: Array<{
      name: string;
      dataType: string;
      isPrimaryKey: boolean;
      isNotNull: boolean;
      isUnique: boolean;
      description: string | undefined;
      enumValues?: string[];
      default?: string;
      defaultFn?: string;
    }>;
    withExplain?: boolean;
    materialized: boolean;
    with: PgSnapshot["views"][number]["with"];
    isExisting: boolean;
    provider: PgSnapshot["provider"];
  },
  "view"
>;

// ReactFlow is scaling everything by the factor of 2
const NODE_WIDTH = 600;
const NODE_ROW_HEIGHT = 100;

// Calculate the maximum width needed for a node based on its column names
const getNodeWidth = (node: TableNodeDefinition | ViewNodeDefinition) => {
  const columnWidths = node.data.columns.map((col) => (col.name.length + col.dataType.length) * 8);
  const headerWidth = node.data.name.length * 8;
  return Math.max(NODE_WIDTH, Math.max(...columnWidths, headerWidth) + 40); // Add padding just in case
};

const ITEM_HEIGHT = 100;

// Calculate the height needed for a node based on its content
const getNodeHeight = (node: TableNodeDefinition | ViewNodeDefinition) => {
  // Base height for header
  const baseHeight = NODE_ROW_HEIGHT;

  if (node.type === "view") {
    // Views, only have columns
    const columnsHeight = Math.max(node.data.columns.length * ITEM_HEIGHT, NODE_ROW_HEIGHT);
    return baseHeight + columnsHeight;
  }

  const tableNode = node as TableNodeDefinition;

  // Calculate height for each component
  const columnsHeight = node.data.columns.length * ITEM_HEIGHT;
  const relationsHeight = tableNode.data.relations.length * ITEM_HEIGHT;
  const policiesHeight = tableNode.data.policies.length * ITEM_HEIGHT;
  const checksHeight = tableNode.data.checks.length * ITEM_HEIGHT;
  const indexesHeight = tableNode.data.indexes.length * ITEM_HEIGHT;
  const foreignKeysHeight = tableNode.data.foreignKeys.length * ITEM_HEIGHT;
  const uniqueConstraintsHeight = tableNode.data.uniqueConstraints.length * ITEM_HEIGHT;
  const compositePrimaryKeysHeight = tableNode.data.compositePrimaryKeys.length * ITEM_HEIGHT;

  // Sum up all components
  const totalComponentsHeight =
    columnsHeight +
    relationsHeight +
    policiesHeight +
    checksHeight +
    indexesHeight +
    foreignKeysHeight +
    uniqueConstraintsHeight +
    compositePrimaryKeysHeight;

  return Math.max(baseHeight + totalComponentsHeight, NODE_ROW_HEIGHT);
};

// Determine optimal edge positions based on node connections
const getNodeEdgePositions = (nodeId: string, edges: Edge[], dagreGraph: dagre.graphlib.Graph) => {
  const currentNode = dagreGraph.node(nodeId);
  const currentX = currentNode.x;

  // Get connected nodes and their positions
  const connectedNodes = edges
    .filter((e) => e.source === nodeId || e.target === nodeId)
    .map((e) => {
      const connectedId = e.source === nodeId ? e.target : e.source;
      const connectedNode = dagreGraph.node(connectedId);
      // Filter out edges where the connected node doesn't exist in the graph (like auth.users)
      if (!connectedNode) {
        return null;
      }

      return {
        id: connectedId,
        isSource: e.source === nodeId,
        x: connectedNode.x,
      };
    })
    .filter((node): node is NonNullable<typeof node> => node !== null);

  // If there's only one connection, align both positions to that side
  if (connectedNodes.length === 1) {
    const position = connectedNodes[0].x > currentX ? Position.Right : Position.Left;
    return { sourcePos: position, targetPos: position };
  }

  // Count nodes on each side
  const leftNodes = connectedNodes.filter((n) => n.x < currentX);
  const rightNodes = connectedNodes.filter((n) => n.x > currentX);

  // If all connections are on one side, align both positions to that side
  if (leftNodes.length > 0 && rightNodes.length === 0) {
    return { sourcePos: Position.Left, targetPos: Position.Left };
  }
  if (rightNodes.length > 0 && leftNodes.length === 0) {
    return { sourcePos: Position.Right, targetPos: Position.Right };
  }

  // Default case: connections on both sides
  return { sourcePos: Position.Right, targetPos: Position.Left };
};

// Supabase, thanks!
const getLayoutedElements = (nodes: (TableNodeDefinition | ViewNodeDefinition)[], edges: Edge[]) => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  const RANK_GROUP_SIZE = 3; // Number of nodes per rank group

  dagreGraph.setGraph({
    rankdir: "LR",
    align: "DL",
    nodesep: 120, // Increased for better horizontal spacing
    ranksep: 200, // Increased for better rank separation
    ranker: "network-simplex",
    marginx: 50,
    marginy: 50,
  });

  // First, add all nodes to the graph
  for (const node of nodes) {
    const width = getNodeWidth(node);
    const height = getNodeHeight(node);
    dagreGraph.setNode(node.id, {
      width: width / 2.5,
      height: height / 2.5,
    });
  }

  // Add edges to the graph
  for (const edge of edges) {
    dagreGraph.setEdge(edge.source, edge.target);
  }

  // Find nodes with no relations
  const connectedNodes = new Set<string>();
  for (const edge of edges) {
    connectedNodes.add(edge.source);
    connectedNodes.add(edge.target);
  }

  // Group nodes into ranks to create a more horizontal layout
  const connectedNodesList = nodes.filter((node) => connectedNodes.has(node.id));
  const unconnectedNodesList = nodes.filter((node) => !connectedNodes.has(node.id));

  // Assign ranks to connected nodes to spread them horizontally
  connectedNodesList.forEach((node, index) => {
    const rankGroup = Math.floor(index / RANK_GROUP_SIZE);
    dagreGraph.setNode(node.id, {
      ...dagreGraph.node(node.id),
      rank: rankGroup * 2,
    });
  });

  // Place unconnected nodes on the far right
  for (const node of unconnectedNodesList) {
    dagreGraph.setNode(node.id, {
      ...dagreGraph.node(node.id),
      rank: 1000,
    });
  }

  // Layout the graph
  dagre.layout(dagreGraph);

  // Apply the layout positions to the nodes
  for (const node of nodes) {
    const nodeWithPosition = dagreGraph.node(node.id);
    const { sourcePos, targetPos } = getNodeEdgePositions(node.id, edges, dagreGraph);

    node.targetPosition = targetPos;
    node.sourcePosition = sourcePos;

    node.position = {
      x: nodeWithPosition.x - nodeWithPosition.width / 2,
      y: nodeWithPosition.y - nodeWithPosition.height / 2,
    };
  }

  return { nodes, edges };
};

export function compute(snapshot: Snapshot) {
  if (!snapshot) {
    return { nodes: [], edges: [] };
  }

  const nodes: Array<TableNodeDefinition | ViewNodeDefinition> = [];
  const edges: Array<Edge> = [];

  switch (snapshot.dialect) {
    case "postgresql": {
      /* Tables */
      for (const table of Object.values(snapshot.tables)) {
        /* Foreign Keys */
        const foreignKeys = Object.values(table.foreignKeys).flatMap((fk) => {
          const fkName = fk.name;
          const tableTo = fk.tableTo;
          const tableFrom = table.name;
          const onDelete = fk.onDelete;
          const onUpdate = fk.onUpdate;

          return fk.columnsFrom.map((columnFrom, colIdx) => {
            const columnTo = fk.columnsTo[colIdx];

            return {
              id: `${fkName}_${colIdx}`,
              fkName,
              tableFrom,
              columnFrom,
              columnTo,
              tableTo,
              onDelete,
              onUpdate,
            };
          });
        });

        for (const foreignKey of foreignKeys) {
          edges.push({
            id: foreignKey.id,
            source: foreignKey.tableTo,
            sourceHandle: `${foreignKey.columnTo}-right`,
            target: foreignKey.tableFrom,
            targetHandle: `${foreignKey.columnFrom}-left`,
            style: { strokeWidth: 2 },
            className: "edge-plain",
            type: "bezier",
          });
        }

        /* Composite Primary Keys */
        const compositePrimaryKeys = Object.values(table.compositePrimaryKeys);

        /* Relations */
        const relations = table.relations;

        for (const relation of relations) {
          edges.push({
            id: crypto.randomUUID(),
            source: relation.referencedTableName,
            sourceHandle: "relation",
            target: table.name,
            targetHandle: relation.fieldName,
            style: { strokeWidth: 2, strokeDasharray: "5" },
            className: "edge-dashed",
            type: "bezier",
          });
        }

        /* Checks */
        const checks = Object.values(table.checkConstraints);

        /* Unique Constraints */
        const uniqueConstraints = Object.values(table.uniqueConstraints);

        /* Indexes */
        const indexes = Object.values(table.indexes);

        /* Policies */
        const policies = Object.values(snapshot.policies);

        /* Nodes */
        nodes.push({
          id: table.name,
          data: {
            name: table.name,
            description: table.description,
            schema: table.schema,
            columns: Object.values(table.columns).map((column) => {
              const foreignKey = foreignKeys.find((fk) => fk.columnFrom === column.name);

              return {
                name: column.name,
                dataType: column.type,
                description: column.description,
                isPrimaryKey:
                  column.primaryKey || compositePrimaryKeys.some((cpk) => cpk.columns.includes(column.name)),
                isForeignKey: Boolean(foreignKey),
                isNotNull: column.notNull,
                isUnique: column.isUnique,
                default: column.default,
                defaultFn: column.defaultFn,
                enumValues: column.enumValues,
                jsonShape: column.jsonShape,
                onDelete: foreignKey?.onDelete,
                onUpdate: foreignKey?.onUpdate,
              };
            }),
            isRLSEnabled: table.isRLSEnabled,
            provider: snapshot.provider,
            checks,
            relations,
            policies,
            compositePrimaryKeys,
            foreignKeys,
            uniqueConstraints,
            indexes,
          },
          position: { x: 0, y: 0 },
          type: "table",
        });
      }

      /* Views */
      for (const view of Object.values(snapshot.views)) {
        nodes.push({
          id: view.name,
          data: {
            name: view.name,
            schema: view.schema,
            definition: view.definition,
            description: view.description,
            columns: Object.values(view.columns).map((column) => {
              return {
                name: column.name,
                dataType: column.type,
                isPrimaryKey: column.primaryKey,
                isNotNull: column.notNull,
                isUnique: column.isUnique,
                default: column.default,
                defaultFn: column.defaultFn,
                enumValues: column.enumValues,
                description: column.description,
              };
            }),
            materialized: view.materialized,
            with: view.with,
            isExisting: view.isExisting,
            provider: snapshot.provider,
          },
          position: { x: 0, y: 0 },
          type: "view",
        });
      }

      break;
    }
    case "sqlite": {
      /* Tables */
      for (const table of Object.values(snapshot.tables)) {
        /* Foreign Keys */
        const foreignKeys = Object.values(table.foreignKeys).flatMap((fk) => {
          const fkName = fk.name;
          const tableTo = fk.tableTo;
          const tableFrom = table.name;
          const onDelete = fk.onDelete;
          const onUpdate = fk.onUpdate;

          return fk.columnsFrom.map((columnFrom, colIdx) => {
            const columnTo = fk.columnsTo[colIdx];

            return {
              id: `${fkName}_${colIdx}`,
              fkName,
              tableFrom,
              columnFrom,
              columnTo,
              tableTo,
              onDelete,
              onUpdate,
            };
          });
        });

        for (const foreignKey of foreignKeys) {
          edges.push({
            id: foreignKey.id,
            source: foreignKey.tableTo,
            sourceHandle: `${foreignKey.columnTo}-right`,
            target: foreignKey.tableFrom,
            targetHandle: `${foreignKey.columnFrom}-left`,
            style: { strokeWidth: 2 },
            className: "edge-plain",
            type: "bezier",
          });
        }

        /* Composite Primary Keys */
        const compositePrimaryKeys = Object.values(table.compositePrimaryKeys);

        /* Relations */
        const relations = table.relations;

        for (const relation of relations) {
          edges.push({
            id: crypto.randomUUID(),
            source: relation.referencedTableName,
            sourceHandle: "relation",
            target: table.name,
            targetHandle: relation.fieldName,
            style: { strokeWidth: 2, strokeDasharray: "5" },
            className: "edge-dashed",
            type: "bezier",
          });
        }

        /* Checks */
        const checks = Object.values(table.checkConstraints);

        /* Unique Constraints */
        const uniqueConstraints = Object.values(table.uniqueConstraints);

        /* Indexes */
        const indexes = Object.values(table.indexes);

        /* Nodes */
        nodes.push({
          id: table.name,
          data: {
            name: table.name,
            description: table.description,
            columns: Object.values(table.columns).map((column) => {
              const foreignKey = foreignKeys.find((fk) => fk.columnFrom === column.name);

              return {
                name: column.name,
                dataType: column.type,
                description: column.description,
                isPrimaryKey:
                  column.primaryKey || compositePrimaryKeys.some((cpk) => cpk.columns.includes(column.name)),
                isForeignKey: Boolean(foreignKey),
                isNotNull: column.notNull,
                isUnique: false,
                default: column.default,
                defaultFn: column.defaultFn,
                enumValues: column.enumValues,
                jsonShape: column.jsonShape,
                onDelete: foreignKey?.onDelete,
                onUpdate: foreignKey?.onUpdate,
              };
            }),
            isRLSEnabled: false,
            provider: undefined,
            checks,
            relations,
            policies: [],
            compositePrimaryKeys,
            foreignKeys,
            uniqueConstraints,
            indexes,
          },
          position: { x: 0, y: 0 },
          type: "table",
        });
      }

      /* Views */
      for (const view of Object.values(snapshot.views)) {
        nodes.push({
          id: view.name,
          data: {
            name: view.name,
            schema: undefined,
            definition: view.definition,
            description: view.description,
            columns: Object.values(view.columns).map((column) => {
              return {
                name: column.name,
                dataType: column.type,
                isPrimaryKey: column.primaryKey,
                isNotNull: column.notNull,
                isUnique: false,
                default: column.default,
                defaultFn: column.defaultFn,
                enumValues: column.enumValues,
                description: column.description,
              };
            }),
            materialized: false,
            with: undefined,
            isExisting: view.isExisting,
            provider: undefined,
          },
          position: { x: 0, y: 0 },
          type: "view",
        });
      }

      break;
    }
    case "mysql": {
      /* Tables */
      for (const table of Object.values(snapshot.tables)) {
        /* Foreign Keys */
        const foreignKeys = Object.values(table.foreignKeys).flatMap((fk) => {
          const fkName = fk.name;
          const tableTo = fk.tableTo;
          const tableFrom = table.name;
          const onDelete = fk.onDelete;
          const onUpdate = fk.onUpdate;

          return fk.columnsFrom.map((columnFrom, colIdx) => {
            const columnTo = fk.columnsTo[colIdx];

            return {
              id: `${fkName}_${colIdx}`,
              fkName,
              tableFrom,
              columnFrom,
              columnTo,
              tableTo,
              onDelete,
              onUpdate,
            };
          });
        });

        for (const foreignKey of foreignKeys) {
          edges.push({
            id: foreignKey.id,
            source: foreignKey.tableTo,
            sourceHandle: `${foreignKey.columnTo}-right`,
            target: foreignKey.tableFrom,
            targetHandle: `${foreignKey.columnFrom}-left`,
            style: { strokeWidth: 2 },
            className: "edge-plain",
            type: "bezier",
          });
        }

        /* Composite Primary Keys */
        const compositePrimaryKeys = Object.values(table.compositePrimaryKeys);

        /* Relations */
        const relations = table.relations;

        for (const relation of relations) {
          edges.push({
            id: crypto.randomUUID(),
            source: relation.referencedTableName,
            sourceHandle: "relation",
            target: table.name,
            targetHandle: relation.fieldName,
            style: { strokeWidth: 2, strokeDasharray: "5" },
            className: "edge-dashed",
            type: "bezier",
          });
        }

        /* Checks */
        const checks = Object.values(table.checkConstraints);

        /* Unique Constraints */
        const uniqueConstraints = Object.values(table.uniqueConstraints);

        /* Indexes */
        const indexes = Object.values(table.indexes);

        /* Nodes */
        nodes.push({
          id: table.name,
          data: {
            name: table.name,
            description: table.description,
            schema: table.schema,
            columns: Object.values(table.columns).map((column) => {
              const foreignKey = foreignKeys.find((fk) => fk.columnFrom === column.name);

              return {
                name: column.name,
                dataType: column.type,
                description: column.description,
                isPrimaryKey:
                  column.primaryKey || compositePrimaryKeys.some((cpk) => cpk.columns.includes(column.name)),
                isForeignKey: Boolean(foreignKey),
                isNotNull: column.notNull,
                isUnique: false,
                default: column.default,
                defaultFn: column.defaultFn,
                enumValues: column.enumValues,
                jsonShape: column.jsonShape,
                onDelete: foreignKey?.onDelete,
                onUpdate: foreignKey?.onUpdate,
              };
            }),
            isRLSEnabled: false,
            provider: undefined,
            checks,
            relations,
            policies: [],
            compositePrimaryKeys,
            foreignKeys,
            uniqueConstraints,
            indexes,
          },
          position: { x: 0, y: 0 },
          type: "table",
        });
      }

      /* Views */
      for (const view of Object.values(snapshot.views)) {
        nodes.push({
          id: view.name,
          data: {
            name: view.name,
            schema: view.schema,
            definition: view.definition,
            description: view.description,
            columns: Object.values(view.columns).map((column) => {
              return {
                name: column.name,
                dataType: column.type,
                isPrimaryKey: column.primaryKey,
                isNotNull: column.notNull,
                isUnique: false,
                default: column.default,
                defaultFn: column.defaultFn,
                enumValues: column.enumValues,
                description: column.description,
              };
            }),
            materialized: false,
            with: undefined,
            isExisting: view.isExisting,
            provider: undefined,
          },
          position: { x: 0, y: 0 },
          type: "view",
        });
      }

      break;
    }
  }

  return getLayoutedElements(nodes, edges);
}
