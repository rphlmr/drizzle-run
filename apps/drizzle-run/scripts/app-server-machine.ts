import { assign, setup } from "xstate";

import { declareType } from "../src/lib/declare-type.ts";

/** The code a process exits with when it handles the SIGTERM `stopServer` sends, as Vite does. */
const SIGTERM_EXIT_CODE = 128 + 15;

/**
 * The local app server's lifetime, and the exit code the serve script ends with
 *
 * ```text
 * running ─stop.request─► stopping ─server.exited─► exited (code, or 0 for the requested SIGTERM)
 *    └──────────server.exited / server.failed──────► exited (code, or 1)
 * ```
 *
 * A server that ends while running stopped on its own, so a signal exit there is a failure. `stopServer` runs once:
 * it signals the server's process group and closes the blog fixture. The placeholder throws so a missing action fails.
 */
export const appServerMachine = setup({
  types: {
    context: declareType<{ exitCode: number | null }>(),
    events: declareType<
      { type: "stop.request" } | { type: "server.exited"; code: number | null } | { type: "server.failed" }
    >(),
  },
  actions: {
    stopServer: () => {
      throw new Error("The app server's stopServer action was not provided");
    },
  },
}).createMachine({
  id: "appServer",
  initial: "running",
  context: { exitCode: null },
  states: {
    running: {
      on: {
        "stop.request": { target: "stopping", actions: "stopServer" },
        "server.exited": {
          target: "exited",
          actions: ["stopServer", assign({ exitCode: ({ event }) => event.code ?? 1 })],
        },
        "server.failed": { target: "exited", actions: ["stopServer", assign({ exitCode: 1 })] },
      },
    },
    stopping: {
      on: {
        "server.exited": {
          target: "exited",
          actions: assign({
            exitCode: ({ event }) => (event.code === null || event.code === SIGTERM_EXIT_CODE ? 0 : event.code),
          }),
        },
        "server.failed": { target: "exited", actions: assign({ exitCode: 1 }) },
      },
    },
    exited: { type: "final" },
  },
});
