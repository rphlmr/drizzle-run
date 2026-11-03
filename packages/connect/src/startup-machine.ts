import { assign, fromPromise, setup } from "xstate";

import { declareType } from "./declare-type.ts";

/** The part of the companion its startup drives. */
export interface StartupCompanion {
  stop(): void | Promise<void>;
}

/**
 * The companion's startup, one step at a time
 *
 * A step that rejects stops the startup with exit code 1, logging the error's message, which says what to fix.
 */
export interface StartupSteps<Agents, Companion extends StartupCompanion, ToolSocket> {
  /** `signal` aborts when a stop comes while the agents are being picked. */
  pickAgents(signal: AbortSignal): Promise<Agents>;
  createWorkdir(): Promise<string>;
  createCompanion(agents: Agents, workdir: string): Companion;
  /** Resolves with no socket when the agents need none. */
  openToolSocket(companion: Companion): Promise<ToolSocket | undefined>;
  /** Start the companion; it runs until something sends `startup.stop`. */
  run(companion: Companion): Promise<void>;
  /** Release every resource the steps made, waiting for one still being made. Never rejects. */
  release(): Promise<void>;
  log(line: string): void;
  exit(exitCode: number): void;
}

interface StartupContext<Agents, Companion, ToolSocket> {
  agents: Agents | undefined;
  companion: Companion | undefined;
  toolSocket: ToolSocket | undefined;
  exitCode: number;
}

/** Stop the companion and exit: Ctrl+C, the companion's own exit, or the MCP stream closing. */
export type StartupEvent = { type: "startup.stop"; exitCode: number };

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build the companion's startup machine
 *
 * `starting` walks the steps, then stays `running`. A stop at any point goes to `stopping`, which stops the companion
 * and releases what the steps made, then exits, so a step that finishes after the stop starts nothing more.
 */
export function createStartupMachine<Agents, Companion extends StartupCompanion, ToolSocket>(
  steps: StartupSteps<Agents, Companion, ToolSocket>,
) {
  const stopOnFailure = {
    target: "#startup.stopping",
    actions: [{ type: "logFailure", params: ({ event }: { event: { error: unknown } }) => event }, "markFailed"],
  } as const;

  return setup({
    types: {
      context: declareType<StartupContext<Agents, Companion, ToolSocket>>(),
      events: declareType<StartupEvent>(),
    },
    actors: {
      pickAgents: fromPromise<Agents>(({ signal }) => steps.pickAgents(signal)),
      createWorkdir: fromPromise<string>(() => steps.createWorkdir()),
      openToolSocket: fromPromise<ToolSocket | undefined, { companion: Companion }>(({ input }) =>
        steps.openToolSocket(input.companion),
      ),
      run: fromPromise<void, { companion: Companion }>(({ input }) => steps.run(input.companion)),
      release: fromPromise<void, { companion: Companion | undefined }>(async ({ input }) => {
        try {
          await input.companion?.stop();
        } finally {
          await steps.release();
        }
      }),
    },
    actions: {
      logFailure: (_, { error }: { error: unknown }) => steps.log(toErrorMessage(error)),
      markFailed: assign({ exitCode: 1 }),
      exit: ({ context }) => steps.exit(context.exitCode),
    },
  }).createMachine({
    id: "startup",
    initial: "starting",
    context: { agents: undefined, companion: undefined, toolSocket: undefined, exitCode: 0 },
    states: {
      starting: {
        initial: "pickingAgents",
        on: {
          "startup.stop": { target: "stopping", actions: assign({ exitCode: ({ event }) => event.exitCode }) },
        },
        states: {
          pickingAgents: {
            invoke: {
              src: "pickAgents",
              onDone: { target: "creatingWorkdir", actions: assign({ agents: ({ event }) => event.output }) },
              onError: stopOnFailure,
            },
          },
          creatingWorkdir: {
            invoke: {
              src: "createWorkdir",
              onDone: {
                target: "openingToolSocket",
                actions: assign({
                  companion: ({ context, event }) =>
                    steps.createCompanion(toStepInput(context.agents, "agents"), event.output),
                }),
              },
              onError: stopOnFailure,
            },
          },
          openingToolSocket: {
            invoke: {
              src: "openToolSocket",
              input: ({ context }) => ({ companion: toStepInput(context.companion, "companion") }),
              onDone: { target: "running", actions: assign({ toolSocket: ({ event }) => event.output }) },
              onError: stopOnFailure,
            },
          },
          running: {
            invoke: {
              src: "run",
              input: ({ context }) => ({ companion: toStepInput(context.companion, "companion") }),
              onError: stopOnFailure,
            },
          },
        },
      },
      stopping: {
        invoke: {
          src: "release",
          input: ({ context }) => ({ companion: context.companion }),
          onDone: "exited",
          onError: "exited",
        },
      },
      exited: { type: "final", entry: "exit" },
    },
  });
}

/** A value an earlier step made; its absence is a broken invariant of the machine. */
function toStepInput<Value>(value: Value | undefined, name: string): Value {
  if (value === undefined) {
    throw new Error(`Expected the ${name} from an earlier startup step, but got undefined.`);
  }

  return value;
}
