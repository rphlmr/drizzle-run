import type { RunManifest } from "@drizzle-run/core/manifest";
import type { createBrowserRuntime, RuntimePreparation } from "@drizzle-run/runtime/browser";
import type { ReadinessRequest } from "@drizzle-run/runtime/machines";

import type { prepareEditor } from "../editor/environment";
import { getErrorText } from "../lib/error-text";
import type { createProjectPreparationRegistry } from "../project/preparation-scope";

type BrowserRuntime = ReturnType<typeof createBrowserRuntime>;

/** A prepared editor whose browser capabilities have been checked. */
export type EditorSession = Awaited<ReturnType<typeof prepareEditor>>;

/** The editor module, loaded on demand so the first paint does not wait for Monaco. */
export type EditorEnvironment = Awaited<ReturnType<typeof loadEditorEnvironment>>;

/** Loads the editor module; at module scope, so the preload helper's retained callback holds no render. */
export function loadEditorEnvironment() {
  return import("../editor/environment");
}

/** What an editor's check hands its preparation: the scope holding what the attempt opens, and its runtime. */
export interface EditorCheck {
  scope: ReturnType<ReturnType<typeof createProjectPreparationRegistry>["create"]>;
  runtime: BrowserRuntime;
}

/** What an editor's readiness request reads: values that outlive a render, never a render's own closures. */
export interface EditorReadinessRequestOptions {
  key: string;
  preparations: ReturnType<typeof createProjectPreparationRegistry>;
  /** The runtime this view prepares on: one the caller supplied, or a shared page runtime. */
  getRuntime: () => Promise<BrowserRuntime>;
  /** Called with the runtime once the check has it, before its capabilities are known. */
  onRuntime: (runtime: BrowserRuntime) => void;
  preparation: RuntimePreparation;
  /** The current files to prepare when eager preparation is enabled. */
  readManifest: () => RunManifest;
  /** Loads and opens the editor; `signal` aborts when the view moves on. */
  openEditor: (signal: AbortSignal) => Promise<EditorSession>;
}

/**
 * Create an editor's readiness request
 *
 * `check` takes the runtime and reads its capabilities; `prepare` loads the editor and, in eager mode, pre-warms
 * the runtime in parallel. On-demand mode starts workers only for a run. One scope holds what the attempt opened.
 * The readiness machine hands it from the check to preparation and releases it when no session takes it; a failed preparation or the session's
 * `dispose` frees it too.
 *
 * Built outside the component: a prepared session's closures keep whatever scope they were made in, and a render's
 * scope reaches the previous render's session, so closures made in render would chain every past session in memory.
 */
export function createEditorReadinessRequest({
  key,
  preparations,
  getRuntime,
  onRuntime,
  preparation,
  readManifest,
  openEditor,
}: EditorReadinessRequestOptions): ReadinessRequest<EditorSession, EditorCheck> {
  return {
    key,
    check: async (signal) => {
      // Not parented to the check signal: the scope must outlive the check and is
      // disposed by the next attempt, a failed prepare, or the effect cleanup.
      const scope = preparations.create(new AbortController().signal);
      const runtime = await getRuntime();

      if (scope.disposed) {
        throw new Error("Project changed during runtime initialization");
      }

      onRuntime(runtime);

      const capabilities = await runtime.checkCapabilities();

      if (scope.disposed || signal.aborted) {
        scope.dispose();
        throw new Error("Project changed during capability detection");
      }

      return { capabilities, checked: { scope, runtime } };
    },
    release: ({ scope }) => scope.dispose(),
    prepare: async ({ scope, runtime }, signal, report) => {
      if (scope.disposed) {
        throw new Error("Project changed before preparation started");
      }

      let session: EditorSession | undefined;

      if (preparation === "eager") {
        const progress = runtime.subscribe((snapshot) => {
          if (snapshot.progress !== undefined && !scope.disposed) {
            report({ type: "download.progress", ...snapshot.progress });
          }
        });
        scope.own(() => progress.unsubscribe());
      }

      scope.own(() => session?.dispose());
      signal.addEventListener("abort", () => scope.dispose(), { once: true });

      try {
        const editorPreparation = openEditor(scope.signal).then(
          (prepared) => {
            if (scope.disposed) {
              prepared.dispose();
            } else {
              session = prepared;
              report({ type: "editor.done" });
            }

            return prepared;
          },
          (cause: unknown) => {
            throw new Error(`Editor preparation failed: ${getErrorText(cause)}`, { cause });
          },
        );

        const prepareRuntime = async () => {
          if (preparation === "eager") {
            try {
              await runtime.prepare(readManifest(), { signal: scope.signal });
            } catch (cause) {
              if (!scope.signal.aborted) {
                console.error("Runtime preparation failed", cause);
              }

              throw new Error(`Runtime preparation failed: ${getErrorText(cause)}`, { cause });
            }
          }

          if (!scope.disposed) {
            report({ type: "runtime.done" });
          }
        };

        await Promise.all([prepareRuntime(), editorPreparation]);

        if (scope.disposed || signal.aborted) {
          throw new Error("Superseded project");
        }

        if (session === undefined) {
          throw new Error("The editor could not be prepared.");
        }

        return { ...session, dispose: scope.dispose } satisfies EditorSession;
      } catch (cause) {
        try {
          scope.dispose();
        } catch (disposeError) {
          console.error(`Project resource cleanup failed: ${getErrorText(disposeError)}`, disposeError);
        }

        throw cause;
      }
    },
  };
}
