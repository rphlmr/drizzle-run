import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_EFFORTS, AGENT_NAMES, connectToolsFor, type ConnectToolScope } from "@drizzle-run/core/connect";
import { attempt } from "es-toolkit";
import * as z from "zod/mini";

import {
  MCP_SERVER_NAME,
  type AgentChoices,
  type AgentLockdown,
  type AgentPlugin,
  type McpLaunch,
  type RunCommand,
  type TurnEvent,
  type TurnSpec,
} from "./contract.ts";
import { getMissingFlags, offerChoices, readVersion, toTomlString } from "./shared.ts";

/**
 * Codex: `exec` without the user's config or rules, in a permission profile that reads only the empty working
 * folder with no network, never asking for approval, with every feature turned off but the ones it needs, and the
 * Drizzle Run MCP server as its only extra tools.
 *
 * Since 0.163, Codex reaches MCP tools only from code mode: one `exec` tool that runs JavaScript with no `require`,
 * `process` or `fetch`, whose only reach is the tools Codex hands it. With `shell_tool` off, those are the Drizzle Run
 * tools, MCP resource reads, a clock, and `apply_patch`. Each turn runs on Codex's own model catalog with
 * `apply_patch` removed; when the catalog cannot be read, the tool stays and the read-only profile rejects it.
 *
 * The system prompt goes in as developer instructions, which Codex ranks above the user's global `AGENTS.md`. That
 * file still reaches the model: Codex reads it from `CODEX_HOME`, which also holds the sign-in.
 *
 * Checked against Codex 0.163.0.
 */

/** Every `codex exec` option the lockdown uses; `codex exec --help` must list them all. */
export const CODEX_REQUIRED_FLAGS = [
  "--json",
  "--config",
  "--skip-git-repo-check",
  "--ignore-user-config",
  "--ignore-rules",
] as const;

/**
 * Codex takes the model slugs and effort levels of its models page (learn.chatgpt.com/docs/models), checked
 * 2026-10-20. Ultra, the docs' level above Max, has no place in the picker. GPT-6 Luna is the one model Free and Go
 * plans have.
 */
export const CODEX_CHOICES: AgentChoices = {
  models: [
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: AGENT_EFFORTS },
    { id: "gpt-6-astra", name: "Astra", efforts: ["low", "medium", "xhigh"] },
    { id: "gpt-6-sol", name: "GPT-6 Sol", efforts: ["low", "medium"] },
    { id: "gpt-6-luna", name: "GPT-6 Luna", efforts: AGENT_EFFORTS },
  ],
  defaults: [
    { model: "gpt-6-sol", effort: "medium" },
    { model: "gpt-6-luna", effort: "medium" },
  ],
};

/**
 * Codex features known to give the agent something beyond the Drizzle Run tools. Each is set false, and so is every
 * other feature `codex features list` names (see `CODEX_ALLOWED_FEATURES`); then the list must read false for all of
 * them, and `shell_tool` (all command execution) must be known.
 */
export const CODEX_DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec_tty",
  "shell_snapshot",
  "view_image",
  "apps",
  "plugins",
  "remote_plugin",
  "multi_agent",
  "image_generation",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "hooks",
  "memories",
  "skill_search",
  "skill_mcp_dependency_install",
  "tool_suggest",
  "in_app_browser",
  "goals",
  "sleep_tool",
  "workspace_dependencies",
  "worktrees",
] as const;

/**
 * Codex features set as a table instead of `false`. `multi_agent_v2` is off, and its native tools are hidden too:
 * a model that asks for the V2 agent tools gets them even with the feature off.
 */
export const CODEX_FEATURE_TABLES: Readonly<Record<string, string>> = {
  multi_agent_v2: "{enabled=false,disable_native_tools=true}",
};

/**
 * Codex features a locked-down turn may keep on
 *
 * `code_mode_host` runs code mode's `exec`, the only way Codex reaches MCP tools. `unified_exec` reads true whatever
 * it is set to, and only shapes the shell tools, which `shell_tool` off removes.
 */
export const CODEX_ALLOWED_FEATURES: readonly string[] = ["code_mode_host", "unified_exec"];

/**
 * Feature stages Drizzle Run never sets: Codex warns on each. A removed feature changes nothing whatever it reads; a
 * deprecated one must still read false.
 */
const CODEX_IGNORED_STAGES: readonly string[] = ["removed", "deprecated"];

const PERMISSIONS_PROFILE = "drizzle-run";

/**
 * The feature names Drizzle Run turns off: segments of lowercase letters, digits and `_`, joined by dots, such as
 * `guardianv2.thread_context`. Codex reads a dotted name as a nested key under `features`, so it never leaves that
 * table, and no character can smuggle another `-c` override; the second listing then checks each reads false.
 */
const FEATURE_NAME = /^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/;

/** Codex items a locked-down turn may produce besides Drizzle Run tool calls. */
const CODEX_ALLOWED_ITEMS: readonly string[] = ["agent_message", "reasoning", "todo_list", "error"];

/** One feature of `codex features list`. */
export interface CodexFeature {
  stage: string;
  enabled: boolean;
}

/**
 * Parse `codex features list` lines: a name, a stage, then `true` or `false`
 *
 * A line is a feature when it has a `true` or `false` word after its name and stage; words after it are ignored, so
 * a new column does not hide a feature. The name is kept as written, even one Drizzle Run cannot turn off, for the
 * check to refuse. Lines without that word, such as a header, are skipped.
 */
export function parseCodexFeatures(text: string): Map<string, CodexFeature> {
  const features = new Map<string, CodexFeature>();

  for (const line of text.split("\n")) {
    const words = line.trim().split(/\s+/);
    const [name] = words;
    const enabledIndex = words.findLastIndex((word) => word === "true" || word === "false");

    if (name === undefined || enabledIndex < 2) {
      continue;
    }

    features.set(name, { stage: words.slice(1, enabledIndex).join(" "), enabled: words[enabledIndex] === "true" });
  }

  return features;
}

/**
 * `-c` overrides that leave Codex with the Drizzle Run MCP server and nothing else
 *
 * `extraFeatures` are the other features this Codex knows, from its check; they are turned off too. The server
 * offers only the tools of `scope`, which run without asking, as the profile allows nothing else.
 */
export function codexConfig(
  mcp: McpLaunch,
  { extraFeatures = [], scope = "project" }: { extraFeatures?: readonly string[]; scope?: ConnectToolScope } = {},
): string[] {
  const features = [...new Set([...CODEX_DISABLED_FEATURES, ...extraFeatures])].filter(
    (feature) => !CODEX_ALLOWED_FEATURES.includes(feature) && !(feature in CODEX_FEATURE_TABLES),
  );
  const mcpServerKey = `mcp_servers.${MCP_SERVER_NAME}`;
  const toolNames = connectToolsFor(scope).map((tool) => toTomlString(tool.name));
  const settings = [
    // A permission profile that reads only the empty working folder and system minimums, with no network.
    `default_permissions=${toTomlString(PERMISSIONS_PROFILE)}`,
    `permissions.${PERMISSIONS_PROFILE}.filesystem={":minimal"="read",":workspace_roots"={"."="read"}}`,
    `permissions.${PERMISSIONS_PROFILE}.network.enabled=false`,
    `approval_policy="never"`,
    `web_search="disabled"`,
    "tools.web_search=false",
    "project_doc_max_bytes=0",
    "skills.include_instructions=false",
    "agents.enabled=false",
    ...features.map((feature) => `features.${feature}=false`),
    ...Object.entries(CODEX_FEATURE_TABLES).map(([feature, table]) => `features.${feature}=${table}`),
    `${mcpServerKey}.command=${toTomlString(mcp.command)}`,
    `${mcpServerKey}.args=[${mcp.args.map(toTomlString).join(",")}]`,
    `${mcpServerKey}.required=true`,
    `${mcpServerKey}.startup_timeout_sec=20`,
    `${mcpServerKey}.enabled_tools=[${toolNames.join(",")}]`,
    `${mcpServerKey}.default_tools_approval_mode="approve"`,
  ];

  return settings.flatMap((setting) => ["-c", setting]);
}

/**
 * Get the arguments for one `codex exec` turn
 *
 * The prompt goes on stdin (`-`), the system prompt in the developer instructions of every turn, so a resumed thread
 * keeps them. Without `modelCatalogFile`, Codex uses its own catalog.
 */
export function codexArgs(
  turn: Omit<TurnSpec, "prompt" | "workdir" | "pluginFolder">,
  modelCatalogFile?: string,
): string[] {
  const commonArgs = [
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    ...codexConfig(turn.mcp, { extraFeatures: turn.lockdown.switchedOff, scope: turn.scope }),
    "-c",
    `developer_instructions=${toTomlString(turn.system)}`,
    ...(modelCatalogFile === undefined ? [] : ["-c", `model_catalog_json=${toTomlString(modelCatalogFile)}`]),
    ...(turn.tuning?.model === undefined ? [] : ["--model", turn.tuning.model]),
    ...(turn.tuning?.effort === undefined ? [] : ["-c", `model_reasoning_effort=${toTomlString(turn.tuning.effort)}`]),
  ];

  if (turn.first || turn.session === undefined) {
    return ["exec", ...commonArgs, "-"];
  }

  return ["exec", "resume", turn.session, ...commonArgs, "-"];
}

/** Whether Drizzle Run already sets this feature: turned off, set as a table, or allowed on. */
function isKnownCodexFeature(feature: string): boolean {
  return (
    CODEX_DISABLED_FEATURES.some((disabled) => disabled === feature) ||
    feature in CODEX_FEATURE_TABLES ||
    CODEX_ALLOWED_FEATURES.includes(feature)
  );
}

/** Whether Codex no longer reads this feature, so Drizzle Run leaves it alone. */
function isIgnoredCodexStage(feature: CodexFeature): boolean {
  return CODEX_IGNORED_STAGES.includes(feature.stage);
}

/**
 * Check Codex's features with every one but `CODEX_ALLOWED_FEATURES` turned off
 *
 * Lists the features once with the known ones off, then again with every other listed feature off too. Passes only
 * when `shell_tool` is known and no feature reads true but an allowed one or one Codex no longer reads; returns the
 * other features to turn off.
 */
async function checkCodexFeatures(
  command: string,
  run: RunCommand,
): Promise<{ ok: true; extraFeatures: string[] } | { ok: false; reason: string }> {
  const probe = { command: "drizzle-run-probe", args: [] } satisfies McpLaunch;
  const firstList = await run(command, [...codexConfig(probe), "features", "list"]);
  const known = parseCodexFeatures(firstList.stdout);
  const extraFeatures = [...known]
    .filter(([name, feature]) => !isKnownCodexFeature(name) && !isIgnoredCodexStage(feature) && FEATURE_NAME.test(name))
    .map(([name]) => name);
  const unsafeNames = [...known.keys()].filter((feature) => !FEATURE_NAME.test(feature));

  if (firstList.status !== 0 || !known.has("shell_tool") || unsafeNames.length > 0) {
    return {
      ok: false,
      reason: `Codex would keep tools Drizzle Run cannot turn off (${unsafeNames.join(", ") || "shell_tool unknown"}). Update it.`,
    };
  }

  const secondList = await run(command, [...codexConfig(probe, { extraFeatures }), "features", "list"]);
  const features = parseCodexFeatures(secondList.stdout);
  const enabledFeatures = [...features]
    .filter(
      ([name, feature]) => feature.enabled && !CODEX_ALLOWED_FEATURES.includes(name) && feature.stage !== "removed",
    )
    .map(([name]) => name);
  const missingFeatures = [...known.keys()].filter((feature) => !features.has(feature));

  if (secondList.status !== 0 || enabledFeatures.length > 0 || missingFeatures.length > 0) {
    return {
      ok: false,
      reason: `Codex would keep tools Drizzle Run cannot turn off (${[...enabledFeatures, ...missingFeatures].join(", ") || "features list failed"}). Update it.`,
    };
  }

  return { ok: true, extraFeatures };
}

/** The file a turn's model catalog is written to, in `AgentLockdown.files`. */
export const CODEX_MODEL_CATALOG_FILE = "model-catalog.json";

/**
 * `codex debug models`: the models the signed-in account has. The other fields are kept, as the catalog goes back to
 * Codex.
 */
const CodexModelCatalogSchema = z.looseObject({
  models: z.array(z.looseObject({ slug: z.string(), visibility: z.optional(z.string()) })),
});

/** What `codex debug models` gives a check. */
interface CodexModelCatalog {
  /** The models Codex lists in its own picker (`visibility: "list"`). */
  accountModels: ReadonlySet<string>;
  /**
   * The catalog with every model's `apply_patch` tool removed, undefined when it cannot be read or Codex does not
   * take it as such.
   */
  catalogWithoutApplyPatch?: string;
}

/** `codex debug models` reading a catalog file: every model must come back without `apply_patch`. */
const CodexCatalogWithoutApplyPatchSchema = z.object({
  models: z.array(z.object({ apply_patch_tool_type: z.null() })),
});

/**
 * Whether Codex takes `catalog` as written, with `apply_patch` off for every model
 *
 * Codex reads the catalog file the way a turn does and prints it back. A Codex that no longer reads the catalog, or
 * no longer names the tool's field `apply_patch_tool_type`, fails the check: its turns then run without the catalog
 * instead of failing.
 */
async function isCodexCatalogTaken(command: string, run: RunCommand, catalog: string): Promise<boolean> {
  const folder = await mkdtemp(join(tmpdir(), "drizzle-run-codex-catalog-"));
  const catalogFile = join(folder, CODEX_MODEL_CATALOG_FILE);

  try {
    await writeFile(catalogFile, catalog, { mode: 0o600 });

    const result = await run(command, ["debug", "models", "-c", `model_catalog_json=${toTomlString(catalogFile)}`]);
    const [, json] = attempt((): unknown => JSON.parse(result.stdout));

    return result.status === 0 && CodexCatalogWithoutApplyPatchSchema.safeParse(json).success;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/**
 * Read the signed-in account's Codex models
 *
 * The account's models only pick which default a chat starts on: the models offered are always `CODEX_CHOICES`.
 * Returns no models and no catalog when the catalog cannot be read, and no catalog when Codex does not take the one
 * without `apply_patch` (see `isCodexCatalogTaken`).
 */
async function readCodexModelCatalog(command: string, run: RunCommand): Promise<CodexModelCatalog> {
  const result = await run(command, ["debug", "models"]);
  const [, json] = attempt((): unknown => JSON.parse(result.stdout));
  const catalog = CodexModelCatalogSchema.safeParse(json);

  if (result.status !== 0 || !catalog.success) {
    return { accountModels: new Set() };
  }

  const { models } = catalog.data;
  // A null `apply_patch_tool_type` leaves the model without Codex's file editing tool.
  const modelsWithoutApplyPatch = models.map((model) => ({ ...model, apply_patch_tool_type: null }));

  const accountModels = new Set(models.filter((model) => model.visibility === "list").map((model) => model.slug));
  const catalogWithoutApplyPatch = JSON.stringify({ ...catalog.data, models: modelsWithoutApplyPatch });

  if (!(await isCodexCatalogTaken(command, run, catalogWithoutApplyPatch))) {
    return { accountModels };
  }

  return { accountModels, catalogWithoutApplyPatch };
}

const CodexThreadStartedSchema = z.looseObject({ type: z.literal("thread.started"), thread_id: z.string() });

// An item that does not say what it is still counts as a tool beyond Drizzle Run's.
const CodexItemEventSchema = z.looseObject({
  type: z.literal(["item.started", "item.updated", "item.completed"]),
  item: z.looseObject({
    type: z.catch(z.string(), "untyped"),
    server: z.catch(z.string(), "unnamed"),
    tool: z.catch(z.string(), "unnamed"),
  }),
});

const CodexAgentMessageSchema = z.looseObject({ type: z.literal("agent_message"), text: z.string() });

const CodexTurnFailedSchema = z.looseObject({
  type: z.literal("turn.failed"),
  error: z.catch(z.optional(z.looseObject({ message: z.catch(z.optional(z.string()), undefined) })), undefined),
});

const CodexTurnCompletedSchema = z.looseObject({ type: z.literal("turn.completed") });

/**
 * Parse a Codex `exec --json` line
 *
 * Every item that is not plain text, reasoning, or a call to an MCP tool is reported as a tool beyond Drizzle Run's.
 * Throws on a line that is not JSON.
 */
export function parseCodexLine(line: string): TurnEvent[] {
  const event: unknown = JSON.parse(line);
  const threadStarted = CodexThreadStartedSchema.safeParse(event);

  if (threadStarted.success) {
    return [{ kind: "session", id: threadStarted.data.thread_id }];
  }

  const itemEvent = CodexItemEventSchema.safeParse(event);

  if (itemEvent.success) {
    const { item } = itemEvent.data;

    if (!CODEX_ALLOWED_ITEMS.includes(item.type)) {
      const name = item.type === "mcp_tool_call" ? `mcp__${item.server}__${item.tool}` : `codex:${item.type}`;

      return [{ kind: "tool", name }];
    }

    const message = CodexAgentMessageSchema.safeParse(item);

    if (itemEvent.data.type === "item.completed" && message.success) {
      return [{ kind: "message" }, { kind: "text", text: message.data.text }];
    }

    return [];
  }

  const turnFailed = CodexTurnFailedSchema.safeParse(event);

  if (turnFailed.success) {
    return [{ kind: "failed", error: turnFailed.data.error?.message ?? "Codex failed." }];
  }

  if (CodexTurnCompletedSchema.safeParse(event).success) {
    return [{ kind: "finished" }];
  }

  return [];
}

export const codexPlugin: AgentPlugin = {
  id: "codex",
  executable: "codex",
  choices: CODEX_CHOICES,
  sessionNaming: "agent",

  async check(command, run) {
    const [versionResult, help] = await Promise.all([run(command, ["--version"]), run(command, ["exec", "--help"])]);
    const helpText = `${help.stdout}\n${help.stderr}`;
    const missingFlags = getMissingFlags(helpText, CODEX_REQUIRED_FLAGS);

    if (help.status !== 0 || missingFlags.length > 0) {
      return {
        ok: false,
        id: "codex",
        reason: `${AGENT_NAMES.codex} lacks options Drizzle Run needs to limit it to its tools (${missingFlags.join(", ") || "no help"}). Update it.`,
      };
    }

    const [features, modelCatalog] = await Promise.all([
      checkCodexFeatures(command, run),
      readCodexModelCatalog(command, run),
    ]);

    if (!features.ok) {
      return { ok: false, id: "codex", reason: features.reason };
    }

    const version = readVersion(versionResult);
    const { accountModels, catalogWithoutApplyPatch } = modelCatalog;
    const lockdown: AgentLockdown = {
      switchedOff: features.extraFeatures,
      files: catalogWithoutApplyPatch === undefined ? {} : { [CODEX_MODEL_CATALOG_FILE]: catalogWithoutApplyPatch },
    };

    return {
      ok: true,
      command,
      lockdown,
      agent: {
        id: "codex",
        name: AGENT_NAMES.codex,
        ...(version ? { version } : {}),
        // Codex takes its effort as a `-c` override, which every version accepts.
        ...offerChoices({ choices: CODEX_CHOICES, help: helpText, accountModels }),
      },
    };
  },

  async prepareTurn(turn) {
    const modelCatalog = turn.lockdown.files[CODEX_MODEL_CATALOG_FILE];

    if (modelCatalog === undefined) {
      return { args: codexArgs(turn), stdin: turn.prompt, cwd: turn.workdir };
    }

    // One folder per turn: chats run turns at once, and Codex names a thread only once its first turn started.
    const turnFolder = join(turn.pluginFolder, "codex", randomUUID());
    const modelCatalogFile = join(turnFolder, CODEX_MODEL_CATALOG_FILE);
    const removeTurnFolder = () => rm(turnFolder, { recursive: true, force: true });

    try {
      await mkdir(turnFolder, { recursive: true, mode: 0o700 });
      await writeFile(modelCatalogFile, modelCatalog, { mode: 0o600 });
    } catch (cause) {
      await removeTurnFolder();
      throw cause;
    }

    return {
      args: codexArgs(turn, modelCatalogFile),
      stdin: turn.prompt,
      cwd: turn.workdir,
      cleanup: removeTurnFolder,
    };
  },

  createParser() {
    return parseCodexLine;
  },
};
