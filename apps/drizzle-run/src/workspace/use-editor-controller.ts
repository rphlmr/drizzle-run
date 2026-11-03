import type { RunManifest } from "@drizzle-run/core/manifest";
import type { createBrowserRuntime, RuntimePreparation } from "@drizzle-run/runtime/browser";
import { createReadinessMachine } from "@drizzle-run/runtime/machines";
import { useActorRef, useSelector } from "@xstate/react";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";

import { getRuntimePolicy } from "../lib/runtime-policy";
import { createProjectPreparationRegistry } from "../project/preparation-scope";
import { createEditorCommandsMachine, type EditorCommand } from "./editor-commands-machine";
import {
  createEditorReadinessRequest,
  loadEditorEnvironment,
  type EditorCheck,
  type EditorEnvironment,
  type EditorSession,
} from "./editor-readiness";

type BrowserRuntime = ReturnType<typeof createBrowserRuntime>;

const editorReadinessMachine = createReadinessMachine<EditorSession, EditorCheck>();

/** Options of `useEditorController`: what the editor is prepared for, and how it opens and takes commands. */
export interface EditorControllerOptions {
  /** What the editor is prepared for; a new key prepares a new editor. */
  environmentKey: string;
  /** A runtime the page already owns, such as the embed's; `getSharedRuntime` gives one otherwise. */
  runtime: BrowserRuntime | undefined;
  /** Override runtime warming when another owner prepares execution children. Defaults to the device policy. */
  preparation?: RuntimePreparation;
  getSharedRuntime: () => Promise<BrowserRuntime>;
  /** Called with the runtime once the check has it, before its capabilities are known. */
  onRuntime: (runtime: BrowserRuntime) => void;
  /** The current files to pre-warm on desktop. */
  readManifest: () => RunManifest;
  /** Opens the editor in `element` once its module loaded; `signal` aborts when the view moves on. */
  openEditor: (environment: EditorEnvironment, signal: AbortSignal, element: HTMLDivElement) => Promise<EditorSession>;
  /** Carries out a command on the ready editor. */
  applyCommand: (session: EditorSession, command: EditorCommand) => void;
}

/**
 * Editor controller
 *
 * Prepares an editor in the element `attachHost` receives, again each time `environmentKey` or `runtime` changes, and
 * queues editor commands until the editor for the current key is ready. `session` is that editor, undefined while it
 * prepares or after it failed.
 */
export function useEditorController({
  environmentKey,
  runtime,
  preparation,
  getSharedRuntime,
  onRuntime,
  readManifest,
  openEditor,
  applyCommand,
}: EditorControllerOptions) {
  const host = useRef<HTMLDivElement | null>(null);
  const attachHost = useCallback((element: HTMLDivElement | null) => {
    host.current = element;
  }, []);
  // Passed as they are: a closure made here would keep this render's callbacks, and the session they saw, alive as
  // long as the request and the machine.
  const readSharedRuntime = useEffectEvent(getSharedRuntime);
  const reportRuntime = useEffectEvent(onRuntime);
  const readCurrentManifest = useEffectEvent(readManifest);
  const openEditorIn = useEffectEvent(openEditor);
  const applyEditorCommand = useEffectEvent(applyCommand);
  const readiness = useActorRef(editorReadinessMachine);
  const ready = useSelector(readiness, (snapshot) => snapshot);
  const [editorCommandsMachine] = useState(() =>
    createEditorCommandsMachine<EditorSession>({ apply: (session, command) => applyEditorCommand(session, command) }),
  );
  const editorCommands = useActorRef(editorCommandsMachine);

  useEffect(() => {
    const element = host.current;

    if (!element) {
      return;
    }

    const preparations = createProjectPreparationRegistry();

    readiness.send({
      type: "readiness.select",
      request: createEditorReadinessRequest({
        key: environmentKey,
        preparations,
        getRuntime: async () => runtime ?? (await readSharedRuntime()),
        onRuntime: (checked) => reportRuntime(checked),
        preparation: preparation ?? getRuntimePolicy(globalThis.navigator).preparation,
        readManifest: () => readCurrentManifest(),
        openEditor: async (signal) => {
          const environment = await loadEditorEnvironment();
          signal.throwIfAborted();

          return openEditorIn(environment, signal, element);
        },
      }),
    });

    return () => {
      try {
        preparations.dispose();
      } finally {
        readiness.send({ type: "readiness.clear" });
      }
    };
  }, [environmentKey, preparation, readiness, runtime]);

  const editorReady = ready.matches("ready") && ready.context.key === environmentKey;
  const session = editorReady ? ready.context.session : undefined;

  useEffect(() => {
    editorCommands.send(session === undefined ? { type: "editor.detach" } : { type: "editor.attach", session });
  }, [editorCommands, session]);

  return { attachHost, readiness, ready, editorReady, session, editorCommands };
}
