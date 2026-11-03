import * as z from "zod/mini";

import { QUERY_PLAN_SIZES } from "../contracts/query-plans.ts";
import { isProjectFilePath, MAX_RUN_FILES } from "../manifest/schema.ts";
import { GUEST_FLAVORS } from "../registry/guest-images.ts";
import { DIALECT_IDS } from "../releases/dialects.ts";
import { createPlainObjectSchema } from "../shared/schema.ts";

/**
 * The Drizzle Run tools an agent gets, and nothing else. The tab executes them against the
 * open project; the companion only lists them (MCP `tools/list`) and forwards calls.
 * Each tool's input is one Zod schema: the companion lists it as JSON Schema, as MCP expects,
 * and `parseToolInput` checks inputs with it on the tab, which never trusts the other side.
 */

/** Every tool an agent can call. */
export type ConnectToolName =
  | "get_project"
  | "read_file"
  | "get_problems"
  | "get_latest_run"
  | "apply_edits"
  | "run"
  | "switch_release"
  | "create_project"
  | "fork_project"
  | "get_query_plans_settings"
  | "set_query_plans_settings"
  | "get_query_plans"
  | "get_guide"
  | "read_docs";

/**
 * Which tools the open view offers
 *
 * `project`: a project of the workspace. `guide`: a guided tour, read only (no edits, no run: the learner presses
 * Run). `snapshot`: a shared link, read only. `untrusted`: a fork of someone else's project the user has not trusted
 * yet, read only until they do.
 */
export type ConnectToolScope = "project" | "guide" | "snapshot" | "untrusted";

/** Every tool scope. */
export const CONNECT_TOOL_SCOPES: readonly ConnectToolScope[] = ["project", "guide", "snapshot", "untrusted"];

/** A side of a side-by-side project, as tools take it. */
export type PairSideInput = 0 | 1;

/**
 * One file edit from an agent
 *
 * Replaces `old_text` (which must match exactly once) with `new_text`, or writes the whole file when `old_text` is
 * absent.
 */
export type FileEditInput = z.output<typeof FileEditSchema>;

/** Each tool's parsed input, keyed by tool name. */
export type ConnectToolInputs = {
  [Name in ConnectToolName]: z.output<(typeof TOOL_INPUT_SCHEMAS)[Name]>;
};

/** A tool call with its parsed input, discriminated by tool name. */
export type ConnectToolCall = {
  [Name in ConnectToolName]: { name: Name; input: ConnectToolInputs[Name] };
}[ConnectToolName];

/** A tool as the companion lists it over MCP. */
export interface ConnectToolDefinition {
  name: ConnectToolName;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  /** Refused in Ask mode: the user must allow edits in the chat first. */
  edits: boolean;
  /** The views that offer it; anywhere else the tab refuses it and the companion does not list it. */
  scopes: readonly ConnectToolScope[];
}

/** Reading the open project works everywhere; changing or running it only in a workspace project the user trusts. */
const READ_SCOPES: readonly ConnectToolScope[] = ["project", "guide", "snapshot", "untrusted"];

/** Someone else's project, read only: a shared link, or a fork the user has not trusted yet. */
const SOMEONE_ELSES: readonly ConnectToolScope[] = ["snapshot", "untrusted"];

const PROJECT_ONLY: readonly ConnectToolScope[] = ["project"];

const GUIDE_ONLY: readonly ConnectToolScope[] = ["guide"];

/** The project files and limits an edit or a new project must respect. */
export const CONNECT_FILE_LIMITS = { maxFiles: MAX_RUN_FILES, maxFileChars: 200_000 } as const;

const SideSchema = z.optional(
  z
    .literal([0, 1], { error: "side must be 0 or 1." })
    .check(
      z.describe(
        "Side-by-side projects only: 0 for the first side, 1 for the second. A shared file is the same on both.",
      ),
    ),
);

const GUEST_FLAVOR_FAILURE = `guest_flavor must be one of ${GUEST_FLAVORS.join(", ")}.`;

const GUEST_FLAVOR_DESCRIPTION =
  "effect runs on the larger image that also loads Effect 4 (only releases get_project lists with + effect).";

const NAME_FAILURE = "name must be 1 to 160 characters.";

/** A project name: 1 to 160 characters, trimmed. */
const ProjectNameSchema = z
  .string({ error: NAME_FAILURE })
  .check(z.maxLength(160, NAME_FAILURE), z.trim(), z.minLength(1, NAME_FAILURE));

const PATH_FAILURE = "path must be a file path.";

const ProjectFilePathSchema = z.string({ error: PATH_FAILURE }).check(
  z.minLength(1, PATH_FAILURE),
  z.refine(isProjectFilePath, {
    error: (issue) => `path must be a project file path such as "schema.ts", not "${String(issue.input)}".`,
  }),
  z.describe("A path from get_project, such as query.ts."),
);

// `toInputMessage` puts `edits[<index>]` in front of these.
const EDIT_FAILURE = " needs path and new_text, and old_text when replacing.";

const FileEditSchema = z.strictObject(
  {
    path: z.string({ error: EDIT_FAILURE }).check(
      z.refine(isProjectFilePath, {
        error: (issue) => `.path must be a project file path such as "schema.ts", not "${String(issue.input)}".`,
      }),
    ),
    old_text: z.optional(
      z.string({ error: EDIT_FAILURE }).check(z.describe("Exact text to replace. Leave out to write the whole file.")),
    ),
    new_text: z.string({ error: EDIT_FAILURE }).check(z.maxLength(CONNECT_FILE_LIMITS.maxFileChars, " is too long.")),
  },
  { error: EDIT_FAILURE },
);

const EDITS_FAILURE = "edits must list 1 to 20 edits.";

const FILES_FAILURE = `files must hold up to ${CONNECT_FILE_LIMITS.maxFiles} text files.`;

const DOCS_URL_FAILURE = "url must be a docs address, such as https://orm.drizzle.team/docs/transactions.";

const QUERY_PLANS_VIEWS = ["reading", "raw"] as const;

/** Each tool's input, in the shape the agent sends it. */
const TOOL_INPUT_SCHEMAS = {
  get_project: z.strictObject({}),
  read_file: z.strictObject({ path: ProjectFilePathSchema, side: SideSchema }),
  get_problems: z.strictObject({}),
  get_latest_run: z.strictObject({ side: SideSchema }),
  apply_edits: z.strictObject({
    edits: z
      .array(FileEditSchema, { error: EDITS_FAILURE })
      .check(z.minLength(1, EDITS_FAILURE), z.maxLength(20, EDITS_FAILURE)),
    side: SideSchema,
    summary: z.optional(
      z
        .string({ error: "summary must be a short line." })
        .check(
          z.maxLength(300, "summary must be a short line."),
          z.describe("One line on what the change does, shown beside Keep and Undo."),
        ),
    ),
  }),
  run: z.strictObject({}),
  switch_release: z.strictObject({
    orm_version: z
      .string({ error: "orm_version must be a version listed by get_project." })
      .check(
        z.minLength(1, "orm_version must be a version listed by get_project."),
        z.describe("Such as 0.45.4 or 1.0.0-rc.5."),
      ),
    side: SideSchema,
    guest_flavor: z.optional(
      z.enum(GUEST_FLAVORS, { error: GUEST_FLAVOR_FAILURE }).check(z.describe(GUEST_FLAVOR_DESCRIPTION)),
    ),
    database: z.optional(
      z
        .enum(DIALECT_IDS, { error: `database must be ${DIALECT_IDS.join(" or ")}.` })
        .check(z.describe("Side-by-side projects only: the database the side moves to. Defaults to the side's own.")),
    ),
  }),
  create_project: z.strictObject({
    name: ProjectNameSchema,
    dialect: z.enum(DIALECT_IDS, { error: `dialect must be ${DIALECT_IDS.join(" or ")}.` }),
    orm_version: z.optional(
      z
        .string({ error: "orm_version must be a version string." })
        .check(z.describe("A tested release; defaults to the newest RC.")),
    ),
    guest_flavor: z.optional(
      z
        .enum(GUEST_FLAVORS, { error: GUEST_FLAVOR_FAILURE })
        .check(z.describe(`${GUEST_FLAVOR_DESCRIPTION} Defaults to slim.`)),
    ),
    files: z.optional(
      z
        .record(
          z.string(),
          z.string({ error: FILES_FAILURE }).check(z.maxLength(CONNECT_FILE_LIMITS.maxFileChars, FILES_FAILURE)),
          { error: "files must map paths to contents." },
        )
        .check(
          z.refine((files) => Object.keys(files).length <= CONNECT_FILE_LIMITS.maxFiles, FILES_FAILURE),
          z.describe("Files by path, such as schema.ts, seed.ts, query.ts."),
        ),
    ),
  }),
  fork_project: z.strictObject({
    name: z.optional(ProjectNameSchema.check(z.describe("Defaults to the open project's name."))),
  }),
  get_query_plans_settings: z.strictObject({}),
  set_query_plans_settings: z.strictObject({
    on: z.optional(z.boolean({ error: "on must be true or false." })),
    size: z.optional(z.enum(QUERY_PLAN_SIZES, { error: `size must be one of ${QUERY_PLAN_SIZES.join(", ")}.` })),
    measure_real_time: z.optional(z.boolean({ error: "measure_real_time must be true or false." })),
  }),
  get_query_plans: z.strictObject({
    view: z.enum(QUERY_PLANS_VIEWS, { error: "view must be reading or raw." }),
    query: z.optional(
      z
        .int({ error: "query must be the index of a planned query." })
        .check(z.minimum(0, "query must be the index of a planned query.")),
    ),
    side: SideSchema,
  }),
  get_guide: z.strictObject({}),
  read_docs: z.strictObject({
    url: z.optional(
      z
        .string({ error: DOCS_URL_FAILURE })
        .check(
          z.maxLength(2_000, DOCS_URL_FAILURE),
          z.trim(),
          z.minLength(1, DOCS_URL_FAILURE),
          z.describe("Such as https://orm.drizzle.team/docs/transactions or /docs/sqlite/select."),
        ),
    ),
  }),
} satisfies Record<ConnectToolName, z.ZodMiniType>;

/** A tool's input schema as JSON Schema, for MCP's `tools/list`. */
function toInputJsonSchema(name: ConnectToolName): Readonly<Record<string, unknown>> {
  const { $schema: _jsonSchemaVersion, ...inputSchema } = z.toJSONSchema(TOOL_INPUT_SCHEMAS[name], { io: "input" });

  return inputSchema;
}

/**
 * Every tool, in the order the companion lists them
 *
 * The companion is installed with npx and the tab is the deployed site, so the two can be on different releases. A
 * tool a newer companion calls and this tab does not know is read as `tool.unknown` and answered `unknown_tool`; add
 * tools without renaming or retyping the ones already shipped, so an older companion keeps working.
 */
export const CONNECT_TOOLS: readonly ConnectToolDefinition[] = [
  {
    name: "get_project",
    description:
      "Describes the Drizzle Run project open in the browser: name, database, Drizzle ORM and Kit release with its flavor (slim or effect) per side, the libraries its guest ships (zod, valibot, effect, ...) with their versions, entry files, every file with its size, the releases it can switch to with their flavors, and the latest run's outcome.",
    inputSchema: toInputJsonSchema("get_project"),
    edits: false,
    scopes: READ_SCOPES,
  },
  {
    name: "read_file",
    description: "Reads one file of the open project, with line numbers.",
    inputSchema: toInputJsonSchema("read_file"),
    edits: false,
    scopes: READ_SCOPES,
  },
  {
    name: "get_problems",
    description: "Lists TypeScript problems in the editor and the problems of the latest run, with file and line.",
    inputSchema: toInputJsonSchema("get_problems"),
    edits: false,
    scopes: READ_SCOPES,
  },
  {
    name: "get_latest_run",
    description:
      "Reads the latest run of the open project: outcome, error, displayed results, console lines, and SQL statements, as the output panel shows them.",
    inputSchema: toInputJsonSchema("get_latest_run"),
    edits: false,
    scopes: READ_SCOPES,
  },
  {
    name: "apply_edits",
    description:
      "Changes files of the open project. Each edit replaces old_text (it must match exactly once) with new_text, or writes the whole file when old_text is left out. The change shows in the editor at once and waits for the user to Keep or Undo it; runs use it meanwhile. Needs Edit mode.",
    inputSchema: toInputJsonSchema("apply_edits"),
    edits: true,
    scopes: PROJECT_ONLY,
  },
  {
    name: "run",
    description:
      "Runs the open project in the browser (a side-by-side project runs both sides) with a fresh database, as the Run button does, and returns the run like get_latest_run. Query plans are planned when they are turned on.",
    inputSchema: toInputJsonSchema("run"),
    edits: false,
    scopes: PROJECT_ONLY,
  },
  {
    name: "switch_release",
    description:
      "Moves the open project (or one side) to another tested Drizzle ORM and Kit release, keeping its files, optionally with Effect (guest_flavor effect). Without guest_flavor the current flavor stays where the release ships it. A side of a side-by-side project may also move to the other database (database): its schema stays as written, so rewrite it for that database after the move (get_problems lists what to fix). Use a release listed by get_project. Needs Edit mode.",
    inputSchema: toInputJsonSchema("switch_release"),
    edits: true,
    scopes: PROJECT_ONLY,
  },
  {
    name: "create_project",
    description:
      "Creates a new project in this browser, optionally with Effect (guest_flavor effect). The current project stays in front and the tools keep acting on it; the result has a link the user opens in a new tab, so pass every file at creation. Starts from the starter files unless files are given. Needs Edit mode.",
    inputSchema: toInputJsonSchema("create_project"),
    edits: true,
    scopes: PROJECT_ONLY,
  },
  {
    name: "fork_project",
    description:
      "Saves a copy of the open shared or someone else's project in this browser. The current view stays in front; the result has a link the user opens in a new tab. The copy stays read only for you until the user presses Allow AI edits there.",
    inputSchema: toInputJsonSchema("fork_project"),
    edits: false,
    scopes: SOMEONE_ELSES,
  },
  {
    name: "get_query_plans_settings",
    description:
      "Reads the Query plans setting of the open project: whether the next run plans its queries, the table size the plans assume, and whether real time is measured.",
    inputSchema: toInputJsonSchema("get_query_plans_settings"),
    edits: false,
    scopes: PROJECT_ONLY,
  },
  {
    name: "set_query_plans_settings",
    description:
      "Turns Query plans on or off for the next run, or changes the size the plans assume (seed, 10k, 100k, 1m rows) or Measure real time (Postgres only: EXPLAIN ANALYZE, writes rolled back). Takes effect on the next run.",
    inputSchema: toInputJsonSchema("set_query_plans_settings"),
    edits: false,
    scopes: PROJECT_ONLY,
  },
  {
    name: "get_query_plans",
    description:
      "Reads the planned queries of the latest run (one side's, side by side). view reading gives Drizzle Run's reading (summary, verdict, indexes it confirmed); view raw gives the database's own output, untouched. query picks one planned query by its index.",
    inputSchema: toInputJsonSchema("get_query_plans"),
    edits: false,
    scopes: PROJECT_ONLY,
  },
  {
    name: "get_guide",
    description:
      "Reads the guided tour the user is following: the guide's release pair (the docs must match it), the current step with its body, what it changes in the code and what changed in the last run, every step's title, and notes for you on what the guide teaches. Call it first in a guided chat.",
    inputSchema: toInputJsonSchema("get_guide"),
    edits: false,
    scopes: GUIDE_ONLY,
  },
  {
    name: "read_docs",
    description:
      "Reads an official Drizzle docs page as text: https://orm.drizzle.team/docs/<page> (PostgreSQL), https://orm.drizzle.team/docs/sqlite/<page> (SQLite), the index https://orm.drizzle.team/llms.txt, or a source the guide lists. Without url it lists the guide's sources, which come first for a Legacy (0.x) guide since the site documents v1. Nothing else on the web.",
    inputSchema: toInputJsonSchema("read_docs"),
    edits: false,
    scopes: GUIDE_ONLY,
  },
];

const toolsByName = new Map<string, ConnectToolDefinition>(CONNECT_TOOLS.map((tool) => [tool.name, tool]));

/** Check whether a value names a known tool. */
export function isConnectToolName(value: unknown): value is ConnectToolName {
  return typeof value === "string" && toolsByName.has(value);
}

/** Get the tools a view offers, in catalog order. */
export function connectToolsFor(scope: ConnectToolScope): readonly ConnectToolDefinition[] {
  return CONNECT_TOOLS.filter((tool) => tool.scopes.includes(scope));
}

/** Check whether a view offers a tool. */
export function isToolInScope(name: ConnectToolName, scope: ConnectToolScope): boolean {
  return toolsByName.get(name)?.scopes.includes(scope) ?? false;
}

/** Check whether a value is a known tool scope. */
export function isConnectToolScope(value: unknown): value is ConnectToolScope {
  return CONNECT_TOOL_SCOPES.some((scope) => scope === value);
}

/**
 * Get the refusal a tab sends for a tool its view does not offer
 *
 * Tells the agent what it can do instead.
 */
export function scopeRefusal(name: ConnectToolName, scope: ConnectToolScope): string {
  if (scope === "guide") {
    return `${name} is not available during a guide: the chat reads only, and the learner presses Run so the guide moves at their pace. Explain instead, and point to the code or the docs.`;
  }

  if (scope === "snapshot") {
    return `${name} is not available on a shared link: it is read only. The user can fork it to change or run it.`;
  }

  if (scope === "untrusted") {
    return `${name} is not available: someone else wrote this project, so you can only read it until the user presses Allow AI edits (in the chat or the project menu). Read and explain instead.`;
  }

  return `${name} is only available during a guided tour.`;
}

/**
 * Get a tool's definition by name
 *
 * Throws when `name` is not a known tool, which `isConnectToolName` rules out.
 */
export function connectTool(name: ConnectToolName): ConnectToolDefinition {
  const tool = toolsByName.get(name);

  if (tool === undefined) {
    throw new Error(`Unknown Drizzle Run tool ${name}.`);
  }

  return tool;
}

/** The result of `parseToolInput`: the typed call, or a message for the agent. */
export type ParsedToolInput = { ok: true; call: ConnectToolCall } | { ok: false; message: string };

const FieldsSchema = createPlainObjectSchema();

/** The message an agent reads for the first problem in its input. */
function toInputMessage(issue: z.core.$ZodIssue): string {
  const [field, index] = issue.path;
  const editLabel = field === "edits" && typeof index === "number" ? `edits[${index}]` : undefined;

  if (issue.code === "unrecognized_keys") {
    const [key] = issue.keys;

    return editLabel === undefined ? `Unknown field ${key}.` : `${editLabel} has an unknown field ${key}.`;
  }

  return editLabel === undefined ? issue.message : `${editLabel}${issue.message}`;
}

type ToolCallParser = (input: unknown) => ParsedToolInput;

function createToolCallParser<Input>(
  schema: z.ZodMiniType<Input>,
  toCall: (input: Input) => ConnectToolCall,
): ToolCallParser {
  return (input) => {
    const parsed = schema.safeParse(input);

    if (!parsed.success) {
      const [issue] = parsed.error.issues;

      return { ok: false, message: issue === undefined ? "The input is invalid." : toInputMessage(issue) };
    }

    return { ok: true, call: toCall(parsed.data) };
  };
}

const TOOL_CALL_PARSERS: Record<ConnectToolName, ToolCallParser> = {
  get_project: createToolCallParser(TOOL_INPUT_SCHEMAS.get_project, (input) => ({ name: "get_project", input })),
  read_file: createToolCallParser(TOOL_INPUT_SCHEMAS.read_file, (input) => ({ name: "read_file", input })),
  get_problems: createToolCallParser(TOOL_INPUT_SCHEMAS.get_problems, (input) => ({ name: "get_problems", input })),
  get_latest_run: createToolCallParser(TOOL_INPUT_SCHEMAS.get_latest_run, (input) => ({
    name: "get_latest_run",
    input,
  })),
  apply_edits: createToolCallParser(TOOL_INPUT_SCHEMAS.apply_edits, (input) => ({ name: "apply_edits", input })),
  run: createToolCallParser(TOOL_INPUT_SCHEMAS.run, (input) => ({ name: "run", input })),
  switch_release: createToolCallParser(TOOL_INPUT_SCHEMAS.switch_release, (input) => ({
    name: "switch_release",
    input,
  })),
  create_project: createToolCallParser(TOOL_INPUT_SCHEMAS.create_project, (input) => ({
    name: "create_project",
    input,
  })),
  fork_project: createToolCallParser(TOOL_INPUT_SCHEMAS.fork_project, (input) => ({ name: "fork_project", input })),
  get_query_plans_settings: createToolCallParser(TOOL_INPUT_SCHEMAS.get_query_plans_settings, (input) => ({
    name: "get_query_plans_settings",
    input,
  })),
  set_query_plans_settings: createToolCallParser(TOOL_INPUT_SCHEMAS.set_query_plans_settings, (input) => ({
    name: "set_query_plans_settings",
    input,
  })),
  get_query_plans: createToolCallParser(TOOL_INPUT_SCHEMAS.get_query_plans, (input) => ({
    name: "get_query_plans",
    input,
  })),
  get_guide: createToolCallParser(TOOL_INPUT_SCHEMAS.get_guide, (input) => ({ name: "get_guide", input })),
  read_docs: createToolCallParser(TOOL_INPUT_SCHEMAS.read_docs, (input) => ({ name: "read_docs", input })),
};

/**
 * Parse a tool call's input
 *
 * Checks the input against the tool's schema, without trusting where it came from. A missing or null input reads as
 * an empty object.
 */
export function parseToolInput(name: ConnectToolName, raw: unknown): ParsedToolInput {
  const input = raw ?? {};

  if (!FieldsSchema.safeParse(input).success) {
    return { ok: false, message: "The input must be an object." };
  }

  return TOOL_CALL_PARSERS[name](input);
}
