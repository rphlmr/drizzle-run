import { readFile } from "node:fs/promises";

import type { RunCommand } from "../src/agents/contract.ts";

/** An agent CLI's probes (`--version`, `--help`, Codex's `features list` and `debug models`). */

export const PERMISSION_MODES = '(choices: "acceptEdits", "bypassPermissions", "default", "dontAsk", "plan")';

/** One feature a fake Codex lists beyond the ones its `-c` overrides name. */
export interface FakeFeature {
  name: string;
  /** The stage Codex prints, such as `stable` or `removed`. */
  stage?: string;
  /** Whether it reads true when no override turns it off. */
  enabled?: boolean;
}

/**
 * Make a CLI that knows `flags` and reports features from its `-c` overrides
 *
 * `forcedOn` features read true whatever they are set to. Without `knowsShellTool`, it never lists `shell_tool`.
 * `extraFeatures` are listed even without an override. `modes` is the help text of `--permission-mode`.
 * `accountModels` are the slugs `debug models` lists, each with the file editing tool; given a catalog file, it prints
 * that file back, unless `ignoresModelCatalog`.
 */
export function makeFakeCli({
  flags,
  forcedOn = [],
  knowsShellTool = true,
  extraFeatures = [],
  modes = PERMISSION_MODES,
  accountModels = [],
  ignoresModelCatalog = false,
}: {
  flags: readonly string[];
  forcedOn?: readonly string[];
  knowsShellTool?: boolean;
  extraFeatures?: readonly (string | FakeFeature)[];
  modes?: string;
  accountModels?: readonly string[];
  ignoresModelCatalog?: boolean;
}): RunCommand {
  return async (_command, args) => {
    const catalogSetting = args.find((arg) => arg.startsWith("model_catalog_json="));

    if (args[0] === "debug" && args[1] === "models" && catalogSetting !== undefined && !ignoresModelCatalog) {
      const catalogFile: unknown = JSON.parse(catalogSetting.slice("model_catalog_json=".length));

      if (typeof catalogFile !== "string") {
        return { status: 1, stdout: "", stderr: "model_catalog_json takes a path" };
      }

      return { status: 0, stdout: await readFile(catalogFile, "utf8"), stderr: "" };
    }

    if (args[0] === "debug" && args[1] === "models") {
      const models = accountModels.map((slug) => ({
        slug,
        visibility: "list",
        apply_patch_tool_type: "freeform",
        base_instructions: `You are ${slug}.`,
      }));

      return { status: 0, stdout: JSON.stringify({ models }), stderr: "" };
    }

    if (args[0] === "--version") {
      return { status: 0, stdout: "1.2.3\n", stderr: "" };
    }

    if (args.includes("--help")) {
      const help = flags.map((flag) => `  ${flag} <value>  ${flag === "--permission-mode" ? modes : "text"}`);

      return { status: 0, stdout: help.join("\n"), stderr: "" };
    }

    const features = new Map(
      extraFeatures
        .map((feature) => (typeof feature === "string" ? { name: feature } : feature))
        .map((feature) => [feature.name, { stage: feature.stage ?? "stable", enabled: feature.enabled ?? true }]),
    );

    for (const arg of args) {
      const match = /^features\.([a-z0-9_.]+)=false$/.exec(arg);

      if (match?.[1] !== undefined && (knowsShellTool || match[1] !== "shell_tool")) {
        const stage = features.get(match[1])?.stage ?? "stable";

        features.set(match[1], { stage, enabled: forcedOn.includes(match[1]) });
      }
    }

    for (const name of forcedOn) {
      const feature = features.get(name);

      if (feature !== undefined) {
        feature.enabled = true;
      }
    }

    const lines = [...features].map(
      ([name, feature]) => `${name.padEnd(30)} ${feature.stage.padEnd(20)} ${String(feature.enabled)}`,
    );

    return { status: 0, stdout: lines.join("\n"), stderr: "" };
  };
}
