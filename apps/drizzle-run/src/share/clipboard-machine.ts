import { assign, fromPromise, setup } from "xstate";

import { declareType } from "../lib/declare-type";

/** How long successful copy feedback stays visible. */
export const COPIED_FEEDBACK_MS = 2_000;
export const CLIPBOARD_WRITE_ACTOR_ID = "writeText";

/** Owns clipboard requests and dismisses success feedback after the most recent copy. */
export function createClipboardMachine({ writeText }: { writeText: (text: string) => Promise<void> }) {
  return setup({
    types: {
      context: declareType<{ text: string; message: string }>(),
      events: declareType<{ type: "clipboard.copy"; text: string; message: string }>(),
    },
    actors: {
      writeText: fromPromise<void, string>(({ input }) => writeText(input)),
    },
  }).createMachine({
    id: "clipboard",
    initial: "idle",
    context: { text: "", message: "" },
    on: {
      "clipboard.copy": {
        target: ".copying",
        reenter: true,
        actions: assign({ text: ({ event }) => event.text, message: ({ event }) => event.message }),
      },
    },
    states: {
      idle: {},
      copying: {
        invoke: {
          id: CLIPBOARD_WRITE_ACTOR_ID,
          src: "writeText",
          input: ({ context }) => context.text,
          onDone: "copied",
          onError: "failed",
        },
      },
      copied: { after: { [COPIED_FEEDBACK_MS]: "idle" } },
      failed: {},
    },
  });
}
