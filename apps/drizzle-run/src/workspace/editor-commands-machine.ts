import { assign, setup } from "xstate";

import { declareType } from "../lib/declare-type";

/** Files written into the editor, such as a guide step's. */
export interface EditorFilesCommand {
  kind: "files";
  version: number;
  files: Readonly<Record<string, string>>;
}

/** Lines marked in the editor, such as a guide step's focus. */
export interface EditorHighlightCommand {
  kind: "highlight";
  version: number;
  file: string;
  /** Without lines, the editor opens the file and marks nothing. */
  lines?: readonly [startLine: number, endLine: number];
  /** Opens the file; false once the learner chose another file before the mark reached the editor. */
  open: boolean;
  /** Brings a phone to the code view. */
  reveal: boolean;
}

/** A command for the editor, carried out once, in order, when the editor is ready. */
export type EditorCommand = EditorFilesCommand | EditorHighlightCommand;

/** What the editor command queue hears. */
export type EditorCommandsEvent<Session> =
  | { type: "editor.attach"; session: Session }
  | { type: "editor.detach" }
  | { type: "command.add"; command: EditorCommand }
  | { type: "file.choose" };

interface EditorCommandsContext<Session> {
  session: Session | undefined;
  /** At most one command of each kind: a newer one replaces the one waiting. */
  queue: readonly EditorCommand[];
  /** The newest version taken of each kind, so a command seen before is never carried out again. */
  versions: Readonly<Record<EditorCommand["kind"], number>>;
}

/** Carries out a command on a ready editor. */
export interface EditorCommandsDependencies<Session> {
  apply: (session: Session, command: EditorCommand) => void;
}

function getSession<Session>(context: EditorCommandsContext<Session>): Session {
  if (context.session === undefined) {
    throw new Error("Expected an attached editor while it takes commands, but got none.");
  }

  return context.session;
}

/**
 * Create the editor command queue
 *
 * ```text
 * detached ─editor.attach─► attached (carries out the waiting commands) ─editor.detach─► detached
 * ```
 *
 * Commands that arrive before the editor is ready wait, one per kind, and run once it is. A command whose version was
 * already taken is refused. `file.choose` keeps the learner's file: a mark still waiting then highlights without
 * opening its file.
 */
export function createEditorCommandsMachine<Session>({ apply }: EditorCommandsDependencies<Session>) {
  return setup({
    types: {
      context: declareType<EditorCommandsContext<Session>>(),
      events: declareType<EditorCommandsEvent<Session>>(),
    },
    guards: {
      isNewCommand: ({ context }, command: EditorCommand) => command.version > context.versions[command.kind],
    },
    actions: {
      take: assign(({ context }, command: EditorCommand) => ({
        versions: { ...context.versions, [command.kind]: command.version },
      })),
      enqueue: assign(({ context }, command: EditorCommand) => ({
        queue: [...context.queue.filter((waiting) => waiting.kind !== command.kind), command],
      })),
      apply: ({ context }, command: EditorCommand) => apply(getSession(context), command),
      drain: ({ context }) => {
        const session = getSession(context);

        for (const command of context.queue) {
          apply(session, command);
        }
      },
      keepFileChoice: assign(({ context }) => ({
        queue: context.queue.map((command) => (command.kind === "highlight" ? { ...command, open: false } : command)),
      })),
    },
  }).createMachine({
    id: "editorCommands",
    initial: "detached",
    context: { session: undefined, queue: [], versions: { files: 0, highlight: 0 } },
    states: {
      detached: {
        on: {
          "editor.attach": {
            target: "attached",
            actions: [assign({ session: ({ event }) => event.session }), "drain", assign({ queue: [] })],
          },
          "command.add": {
            guard: { type: "isNewCommand", params: ({ event }) => event.command },
            actions: [
              { type: "take", params: ({ event }) => event.command },
              { type: "enqueue", params: ({ event }) => event.command },
            ],
          },
          "file.choose": { actions: "keepFileChoice" },
        },
      },
      attached: {
        on: {
          "editor.attach": { actions: assign({ session: ({ event }) => event.session }) },
          "editor.detach": { target: "detached", actions: assign({ session: undefined }) },
          "command.add": {
            guard: { type: "isNewCommand", params: ({ event }) => event.command },
            actions: [
              { type: "take", params: ({ event }) => event.command },
              { type: "apply", params: ({ event }) => event.command },
            ],
          },
        },
      },
    },
  });
}
