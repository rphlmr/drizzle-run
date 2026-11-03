import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import { CONNECT_LIMITS } from "@drizzle-run/core/connect";
import { assign, createActor, enqueueActions, fromCallback, not, sendTo, setup, toPromise } from "xstate";

import { toDrizzleRunToolName, type TurnEvent, type TurnParser } from "./agents/index.ts";
import { declareType } from "./declare-type.ts";

/**
 * One agent turn: a CLI process that reads the prompt on stdin and streams JSON lines.
 * Text is batched (about 250 ms) so a reply costs a few relay messages, not one per token.
 */

/** How a turn ended. A refused turn ends `failed` with the refusal's reason. */
export type TurnEnd = { state: "done" } | { state: "stopped" } | { state: "failed"; error: string };

/** One turn to run: the CLI command, its arguments, and where its output goes. */
export interface TurnOptions {
  command: string;
  args: readonly string[];
  prompt: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  onText(text: string): void;
  /** A CLI that names its own session says it on the first turn; later turns resume it. */
  onSession?(id: string): void;
  /** Reads the CLI's output: the agent plugin's parser for this turn. */
  parser: TurnParser;
  /**
   * The Drizzle Run tools this turn may use, such as `get_project`. The parser reports each tool the agent calls, and
   * anything beyond these (a shell, files, web, another MCP server) fails the turn at once and ends the CLI, as does
   * a CLI the parser finds started with more than its lockdown allows.
   */
  allowedTools: readonly string[];
  batchMs?: number;
}

/** A turn in progress. `stop` ends the CLI and every process it started. */
export interface RunningTurn {
  done: Promise<TurnEnd>;
  stop(): void;
}

const MAX_STDERR_TAIL_LENGTH = 2_000;
const STOP_GRACE_MS = 3_000;

/** What the agent's process reports: its parsed lines, its stderr, and its end. */
type AgentProcessEvent =
  | { type: "agent.text"; text: string }
  | { type: "agent.message" }
  | { type: "agent.session"; id: string }
  | { type: "agent.failed"; error: string }
  | { type: "agent.unsafe"; reason: string }
  | { type: "agent.tool"; name: string }
  | { type: "process.stderr"; chunk: string }
  | { type: "process.error"; message: string }
  | { type: "process.closed"; exitCode: number | null };

type TurnMachineEvent = AgentProcessEvent | { type: "turn.stop" } | { type: "text.batched" };

type AgentProcessCommand = { type: "process.signal"; signal: NodeJS.Signals };

/** The agent CLI to start. */
interface AgentProcessInput {
  command: string;
  args: readonly string[];
  prompt: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  parser: TurnParser;
}

/** The turn's text and what it learned from the process. */
interface TurnContext {
  /** Text waiting for the next batch. */
  pendingText: string;
  /** Where the next text lands: nothing written yet, inside a message, or at the start of the next one. */
  textBoundary: "start" | "within" | "next_message";
  /** Why the turn failed, as the CLI reported it. */
  failure: string | undefined;
  /** Why Drizzle Run ended the turn: a tool beyond its own, or a CLI started with more than its lockdown allows. */
  refusal: string | undefined;
  stderrTail: string;
  exitCode: number | null;
  /** How the turn ended, once it did. */
  end: TurnEnd | undefined;
}

function toAgentProcessEvent(event: TurnEvent): AgentProcessEvent | undefined {
  switch (event.kind) {
    case "text":
      return { type: "agent.text", text: event.text };
    case "message":
      return { type: "agent.message" };
    case "session":
      return { type: "agent.session", id: event.id };
    case "failed":
      return { type: "agent.failed", error: event.error };
    case "unsafe":
      return { type: "agent.unsafe", reason: event.reason };
    case "tool":
      return { type: "agent.tool", name: event.name };
    case "finished":
      return undefined;
  }
}

function sendSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || (process.platform === "win32" && child.exitCode !== null)) {
    return;
  }

  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    // Already gone.
  }
}

/** Runs the CLI in its own process group, so a signal ends it and the MCP server it started. */
const agentProcessLogic = fromCallback<AgentProcessCommand, AgentProcessInput, AgentProcessEvent>(
  ({ input, sendBack, receive }) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      let parsedEvents: TurnEvent[];

      try {
        parsedEvents = input.parser(line);
      } catch {
        return;
      }

      for (const parsed of parsedEvents) {
        const event = toAgentProcessEvent(parsed);

        if (event !== undefined) {
          sendBack(event);
        }
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => sendBack({ type: "process.stderr", chunk }));
    child.on("error", (error) => sendBack({ type: "process.error", message: error.message }));
    child.on("close", (exitCode) => sendBack({ type: "process.closed", exitCode }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input.prompt);

    receive((command) => sendSignal(child, command.signal));
  },
);

/**
 * Build a turn's machine
 *
 * `running` streams the agent's text. A refusal kills the CLI at once and keeps its reason, whatever comes after; a
 * stop asks the CLI to end, then kills it after a grace time. The turn ends when the process closes.
 */
export function createTurnMachine(options: TurnOptions) {
  const allowedNames = new Set(options.allowedTools.map(toDrizzleRunToolName));

  return setup({
    types: {
      context: declareType<TurnContext>(),
      events: declareType<TurnMachineEvent>(),
      output: declareType<TurnEnd>(),
    },
    actors: { agentProcess: agentProcessLogic },
    delays: {
      batch: options.batchMs ?? CONNECT_LIMITS.textBatchMs,
      stopGrace: STOP_GRACE_MS,
    },
    guards: {
      hasText: ({ event }) => event.type === "agent.text" && event.text !== "",
      isAllowedTool: ({ event }) => event.type === "agent.tool" && allowedNames.has(event.name),
      hasFailure: ({ context }) => context.failure !== undefined,
      hasExitedCleanly: ({ event }) => event.type === "process.closed" && event.exitCode === 0,
    },
    actions: {
      signalAgent: sendTo("agentProcess", (_, params: { signal: NodeJS.Signals }): AgentProcessCommand => ({
        type: "process.signal",
        signal: params.signal,
      })),
      pushText: enqueueActions(({ enqueue, context, event }) => {
        if (event.type !== "agent.text") {
          return;
        }

        const separator = context.textBoundary === "next_message" ? "\n\n" : "";

        enqueue.assign({ pendingText: `${context.pendingText}${separator}${event.text}`, textBoundary: "within" });
        enqueue.raise({ type: "text.batched" });
      }),
      startMessage: assign({
        textBoundary: ({ context }) => (context.textBoundary === "start" ? "start" : "next_message"),
      }),
      flushText: enqueueActions(({ enqueue, context }) => {
        if (context.pendingText === "") {
          return;
        }

        options.onText(context.pendingText);
        enqueue.assign({ pendingText: "" });
      }),
      reportSession: ({ event }) => {
        if (event.type === "agent.session") {
          options.onSession?.(event.id);
        }
      },
      keepFailure: assign({
        failure: ({ event }) => (event.type === "agent.failed" ? event.error : undefined),
      }),
      refuseUnsafe: assign({ refusal: ({ event }) => (event.type === "agent.unsafe" ? event.reason : undefined) }),
      refuseTool: assign({
        refusal: ({ event }) =>
          event.type === "agent.tool"
            ? `The agent tried ${event.name}, which is not a Drizzle Run tool of this chat, so Drizzle Run stopped it.`
            : undefined,
      }),
    },
  }).createMachine({
    id: "turn",
    initial: "live",
    context: {
      pendingText: "",
      textBoundary: "start",
      failure: undefined,
      refusal: undefined,
      stderrTail: "",
      exitCode: null,
      end: undefined,
    },
    states: {
      live: {
        type: "parallel",
        invoke: {
          id: "agentProcess",
          src: "agentProcess",
          input: {
            command: options.command,
            args: options.args,
            prompt: options.prompt,
            cwd: options.cwd,
            env: options.env,
            parser: options.parser,
          },
        },
        exit: [
          "flushText",
          assign({ exitCode: ({ event }) => (event.type === "process.closed" ? event.exitCode : null) }),
        ],
        on: {
          "agent.session": { actions: "reportSession" },
          "process.stderr": {
            actions: assign({
              stderrTail: ({ context, event }) => `${context.stderrTail}${event.chunk}`.slice(-MAX_STDERR_TAIL_LENGTH),
            }),
          },
          "process.error": {
            guard: not("hasFailure"),
            actions: assign({ failure: ({ event }) => event.message }),
          },
        },
        states: {
          lifecycle: {
            initial: "running",
            states: {
              running: {
                on: {
                  "agent.text": { guard: "hasText", actions: "pushText" },
                  "agent.message": { actions: "startMessage" },
                  "agent.failed": { actions: "keepFailure" },
                  "agent.unsafe": { target: "refusing", actions: "refuseUnsafe" },
                  "agent.tool": { guard: not("isAllowedTool"), target: "refusing", actions: "refuseTool" },
                  "turn.stop": "stopping",
                  "process.closed": [
                    { guard: "hasFailure", target: "#turn.failed" },
                    { guard: "hasExitedCleanly", target: "#turn.done" },
                    { target: "#turn.failed" },
                  ],
                },
              },
              /** Drizzle Run ended the CLI: nothing it writes now reaches the chat, and the refusal says why. */
              refusing: {
                entry: { type: "signalAgent", params: { signal: "SIGKILL" } },
                on: {
                  "process.closed": "#turn.refused",
                },
              },
              stopping: {
                entry: { type: "signalAgent", params: { signal: "SIGTERM" } },
                after: { stopGrace: { actions: { type: "signalAgent", params: { signal: "SIGKILL" } } } },
                on: {
                  "agent.text": { guard: "hasText", actions: "pushText" },
                  "agent.message": { actions: "startMessage" },
                  "agent.unsafe": { target: "refusing", actions: "refuseUnsafe" },
                  "agent.tool": { guard: not("isAllowedTool"), target: "refusing", actions: "refuseTool" },
                  "process.closed": "#turn.stopped",
                },
              },
            },
          },
          batch: {
            initial: "idle",
            states: {
              idle: {
                on: { "text.batched": "waiting" },
              },
              waiting: {
                after: { batch: { target: "idle", actions: "flushText" } },
              },
            },
          },
        },
      },
      done: {
        type: "final",
        entry: assign({ end: { state: "done" } }),
      },
      stopped: {
        type: "final",
        entry: assign({ end: { state: "stopped" } }),
      },
      refused: {
        type: "final",
        entry: assign({
          end: ({ context }): TurnEnd => {
            if (context.refusal === undefined) {
              throw new Error("Expected a refused turn to keep why it was refused");
            }

            return { state: "failed", error: context.refusal };
          },
        }),
      },
      failed: {
        type: "final",
        entry: assign({
          end: ({ context }): TurnEnd => {
            if (context.failure !== undefined) {
              return { state: "failed", error: context.failure };
            }

            const lastStderrLines = context.stderrTail.trim().split("\n").slice(-3).join("\n");

            return {
              state: "failed",
              error: lastStderrLines || `The agent exited with code ${String(context.exitCode)}.`,
            };
          },
        }),
      },
    },
    output: ({ context }) => {
      if (context.end === undefined) {
        throw new Error("Expected an ended turn to say how it ended");
      }

      return context.end;
    },
  });
}

/**
 * Start an agent turn
 *
 * Text of separate messages is joined with a blank line. Lines that are not JSON are skipped.
 * A turn that exits non-zero without a reported failure fails with the last stderr lines.
 */
export function startTurn(options: TurnOptions): RunningTurn {
  const turn = createActor(createTurnMachine(options));

  turn.start();

  return {
    done: toPromise(turn),
    stop: () => turn.send({ type: "turn.stop" }),
  };
}
