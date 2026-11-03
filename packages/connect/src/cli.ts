#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_NAMES,
  connectCommand,
  connectToolsFor,
  DEFAULT_CONNECT_ORIGIN,
  type AgentId,
} from "@drizzle-run/core/connect";
import { createActor, type Actor } from "xstate";

import { detectAgents, type UsableAgent } from "./agents/index.ts";
import { AGENT_NAME_LIST, parseArgs, USAGE } from "./args.ts";
import { Companion } from "./companion.ts";
import { clearPairing, connectHome, readPairing, writePairing } from "./home.ts";
import { connectToolSocket, openToolSocket, type ToolSocket } from "./ipc.ts";
import { serveMcp } from "./mcp-server.ts";
import { createStartupMachine } from "./startup-machine.ts";
import { createStartupResources } from "./startup-resources.ts";
import { VERSION } from "./version.ts";

/** Where a pkg.pr.new build of the companion is published; scripts/build.ts defines it, null for the npm release. */
declare const __CONNECT_PACKAGE__: string | null | undefined;

// Tests run the source, where nothing defines it.
const publishedPackageCommand = typeof __CONNECT_PACKAGE__ === "string" ? `npx ${__CONNECT_PACKAGE__}` : undefined;

function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

function fail(message: string): never {
  log(message);
  process.exit(1);
}

function formatAgentList(agents: readonly UsableAgent[]): string {
  return agents.map(({ agent }) => `${agent.name}${agent.version ? ` (${agent.version})` : ""}`).join(", ");
}

interface PickedAgents {
  usable: UsableAgent[];
  chosen: AgentId | undefined;
}

/** Detect the chat agents and pick the requested one, or the only one; rejects with what to fix when none fits. */
async function pickAgents(requestedAgent: AgentId | undefined, signal: AbortSignal): Promise<PickedAgents> {
  const detected = await detectAgents({ signal });

  for (const refused of detected.refused) {
    log(refused.reason);
  }

  const usable = detected.usable;

  if (usable.length === 0) {
    throw new Error(`Install ${AGENT_NAME_LIST}, sign in once in a terminal, then run this again.`);
  }

  if (requestedAgent !== undefined && !usable.some((entry) => entry.agent.id === requestedAgent)) {
    throw new Error(`${AGENT_NAMES[requestedAgent]} is not available here.`);
  }

  log(`Agents: ${formatAgentList(usable)}.`);

  return { usable, chosen: requestedAgent ?? (usable.length === 1 ? usable[0]?.agent.id : undefined) };
}

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2));

  if (command.kind === "error") {
    fail(`${command.message}\n\n${USAGE}`);
  }

  if (command.kind === "help") {
    process.stdout.write(USAGE);
    return;
  }

  if (command.kind === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (command.kind === "forget") {
    await clearPairing();
    log(`Forgot the pairing in ${connectHome()}.`);
    return;
  }

  if (command.kind === "mcp_ipc") {
    // Started by the agent as its MCP server: stdout is the MCP stream, so nothing else is printed.
    const toolLink = connectToolSocket(command.socket, command.token);

    serveMcp({
      input: process.stdin,
      output: process.stdout,
      call: toolLink.call,
      tools: connectToolsFor(command.scope),
      onClose: () => {
        toolLink.close();
        process.exit(0);
      },
    });
    return;
  }

  // Resolve the pairing
  const storedPairing = await readPairing();
  const relay =
    command.relay ?? (command.secret === undefined ? storedPairing?.relay : undefined) ?? DEFAULT_CONNECT_ORIGIN;
  const secret = command.secret ?? storedPairing?.secret;

  if (secret === undefined) {
    fail("This computer is not paired yet. In Drizzle Run, open AI chat and run the command it shows.");
  }

  if (command.secret !== undefined) {
    await writePairing({ secret, relay, pairedAt: new Date().toISOString() });
    log(
      `Paired. Next time, run ${connectCommand({ origin: relay, packageCommand: publishedPackageCommand })} to rejoin.`,
    );
  }

  // Take Ctrl+C from here on, before any startup step makes something to clean up. Left to Node's default, a signal
  // during startup kills the process outright: no exit code, and the agent's folder stays behind.
  const startupResources = createStartupResources();
  const cliPath = fileURLToPath(import.meta.url);
  const startup: Actor<ReturnType<typeof createStartupMachine<PickedAgents, Companion, ToolSocket>>> = createActor(
    createStartupMachine<PickedAgents, Companion, ToolSocket>({
      pickAgents: (signal) =>
        command.mcp ? Promise.resolve({ usable: [], chosen: undefined }) : pickAgents(command.agent, signal),
      createWorkdir: () =>
        startupResources.track(mkdtemp(join(tmpdir(), "drizzle-run-agent-")), (folder) =>
          rm(folder, { recursive: true, force: true }),
        ),
      createCompanion: ({ usable, chosen }, workdir) =>
        new Companion({
          secret,
          relay,
          mode: command.mcp ? "mcp" : "chat",
          agents: usable,
          ...(chosen ? { agent: chosen } : {}),
          workdir,
          mcpLaunch: (token, scope) => ({
            command: process.execPath,
            args: [
              ...process.execArgv,
              cliPath,
              "--mcp-ipc",
              startup.getSnapshot().context.toolSocket?.path ?? "",
              "--turn",
              token,
              "--scope",
              scope,
            ],
          }),
          forget: () => clearPairing(),
          log,
          exit: (reason) => startup.send({ type: "startup.stop", exitCode: reason === "relay_unreachable" ? 1 : 0 }),
        }),
      openToolSocket: (companion) =>
        command.mcp
          ? Promise.resolve(undefined)
          : startupResources.track(
              openToolSocket((token, name, input) => companion.callTool(token, name, input)),
              (socket) => socket.close(),
            ),
      run: (companion) => {
        if (command.mcp) {
          serveMcp({
            input: process.stdin,
            output: process.stdout,
            call: (name, input) => companion.callTool(undefined, name, input),
            onClose: () => startup.send({ type: "startup.stop", exitCode: 0 }),
          });
        }

        log(`Drizzle Run connect ${VERSION}, relay ${relay}. Press Ctrl+C to stop.`);

        return companion.start();
      },
      release: () => startupResources.release(),
      log,
      exit: (exitCode) => process.exit(exitCode),
    }),
  );

  process.on("SIGINT", () => startup.send({ type: "startup.stop", exitCode: 0 }));
  process.on("SIGTERM", () => startup.send({ type: "startup.stop", exitCode: 0 }));
  startup.start();
}

main().catch((cause: unknown) => {
  fail(cause instanceof Error ? cause.message : String(cause));
});
