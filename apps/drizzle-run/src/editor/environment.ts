import type { RunManifest } from "@drizzle-run/core/manifest";
import type { ProjectTypeEnvironment } from "@drizzle-run/runtime/type-environment";
import {
  addImportedLibraries,
  createProjectTypeEnvironment,
  listModuleReferences,
} from "@drizzle-run/runtime/type-environment";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TypeScriptLanguageWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { createActor } from "xstate";

import { EDITOR_TEXT, resolveEditorText, type EditorFontSize, type EditorText } from "../design/editor-font-size";
import { applyMonacoTheme, getMonacoThemeName, watchMonacoTheme } from "../design/monaco-theme";
import type { RunNote } from "../ui/run-notes";
import { formatEditorFiles, registerPrettierFormatting } from "./format";
import { createImportScanMachine } from "./import-scan-machine";
import { getEditorLanguage } from "./language";
import { resolveMonacoLibraries } from "./libraries";
import { createRunNotesLayer, getIndentColumns } from "./run-notes";
import { isolateProjectTypeEnvironment, namespaceProjectTypeEnvironment } from "./session-environment";
import { findChangedSpan } from "./text-span";

self.MonacoEnvironment = {
  getWorker: (_id, label) => {
    if (label === "typescript" || label === "javascript") {
      return new TypeScriptLanguageWorker();
    }

    if (label === "json") {
      return new JsonWorker();
    }

    return new EditorWorker();
  },
};

/** The packages `sources` import, as one comparable string. */
function toImportKey(sources: readonly string[]): string {
  return [...new Set(sources.flatMap((source) => listModuleReferences(source).bare))].toSorted().join("\n");
}

/** Options of `prepareEditor`. */
export interface PrepareEditorOptions {
  /**
   * One side of a side-by-side project: its packages resolve through its own session, so two
   * editors on one page each check against their own release. `globals` keeps the `$` helpers
   * declared; only one side declares them.
   */
  isolation?: { globals: boolean };
}

/** The slots of the open editor sessions; a new session takes the lowest free one. */
const openEditorSlots = new Set<number>();

/**
 * Take the lowest free editor slot
 *
 * A session's virtual files live under its slot rather than a random id: Monaco remembers every extra library URI it
 * ever removed, so a fresh id per session would grow that record by every declaration file on each preparation.
 * Sessions open at the same time never share a slot, so their files never collide.
 */
function acquireEditorSlot(): { id: string; release: () => void } {
  let index = 0;

  while (openEditorSlots.has(index)) {
    index += 1;
  }

  openEditorSlots.add(index);

  let released = false;

  // Once only: a later session may already hold the slot again when a disposed session is disposed twice.
  const release = () => {
    if (!released) {
      released = true;
      openEditorSlots.delete(index);
    }
  };

  return { id: `slot-${index}`, release };
}

/** Options as one string that does not depend on key order. */
function toOptionsKey(options: object): string {
  return JSON.stringify(options, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)))
      : value,
  );
}

/** Whether two option objects hold the same values, whatever their key order. */
function hasSameOptions(previous: object, next: object): boolean {
  return toOptionsKey(previous) === toOptionsKey(next);
}

type LanguageDefaults = typeof monaco.typescript.typescriptDefaults;

/** Each change of a program's options restarts its TypeScript worker, so this sets them only when they differ. */
function setLanguageOptions(
  defaults: LanguageDefaults,
  compilerOptions: monaco.typescript.CompilerOptions,
  diagnosticsOptions: monaco.typescript.DiagnosticsOptions,
) {
  if (!hasSameOptions(defaults.getCompilerOptions(), compilerOptions)) {
    defaults.setCompilerOptions(compilerOptions);
  }

  if (!hasSameOptions(defaults.getDiagnosticsOptions(), diagnosticsOptions)) {
    defaults.setDiagnosticsOptions(diagnosticsOptions);
  }

  defaults.setEagerModelSync(true);
}

/**
 * The `typeRoots` of every editor session this page opened
 *
 * Both side editors share Monaco's one TypeScript program, so its `typeRoots` are every session's: a SQLite side
 * prepared after a PostgreSQL one must not drop the Node types the PostgreSQL side declares. They only grow, since each
 * change restarts the TypeScript worker: a closed session's roots hold no files once its libraries go, and the next
 * session on its slot reuses them.
 */
const sessionTypeRoots = new Set<string>();

/**
 * Replace a model's text with `content` by editing only the span that differs
 *
 * A keystroke mirrored from the other side is then a one-character edit: the TypeScript worker syncs that span, and
 * undo holds that change, rather than the whole file. Does nothing when the text is already `content`, whatever its line
 * endings.
 */
function replaceModelText(model: monaco.editor.ITextModel, content: string) {
  // The model keeps its own line endings, so text that differs only in them is the same text.
  const text = content.replace(/\r\n|\r|\n/g, model.getEOL());
  const span = findChangedSpan(model.getValue(), text);

  if (span === null) {
    return;
  }

  const range = monaco.Range.fromPositions(model.getPositionAt(span.start), model.getPositionAt(span.end));

  model.pushEditOperations([], [{ range, text: span.text }], () => null);
}

/** Prepares an editor on `host` for the manifest's files, with the type environment of its packages. */
export async function prepareEditor(
  host: HTMLElement,
  manifest: RunManifest,
  onEdit: (path: string, content: string) => void,
  signal: AbortSignal,
  onNavigate: (path: string) => void,
  initialPath: string,
  options: PrepareEditorOptions = {},
) {
  const openedEnvironment = await createProjectTypeEnvironment(
    manifest,
    options.isolation ? { contextDeclaration: "module" } : {},
  );

  if (signal.aborted) {
    throw new Error("Project changed during declaration loading");
  }

  const slot = acquireEditorSlot();
  const slotId = slot.id;
  const toSessionEnvironment = (generated: ProjectTypeEnvironment) => {
    const namespaced = namespaceProjectTypeEnvironment(generated, slotId);

    return options.isolation ? isolateProjectTypeEnvironment(namespaced, slotId, options.isolation) : namespaced;
  };
  let environment: ProjectTypeEnvironment;

  try {
    environment = toSessionEnvironment(openedEnvironment);
  } catch (cause) {
    slot.release();
    throw cause;
  }

  // Dispose drops it, so a stale closure that still holds this session keeps neither its declarations nor the caller's
  // render scope alive.
  let liveInputs: {
    manifest: RunManifest;
    generatedEnvironment: ProjectTypeEnvironment;
    onEdit: (path: string, content: string) => void;
    onNavigate: (path: string) => void;
  } | null = { manifest, generatedEnvironment: openedEnvironment, onEdit, onNavigate };

  const ts = monaco.typescript;
  const monacoLibraries = resolveMonacoLibraries(environment.compilerOptions.lib);
  // TypeScript 5.9 in Monaco has no ES2025 target; its ESNext accepts the same syntax.
  const monacoTargets = { ES2025: ts.ScriptTarget.ESNext } satisfies Record<
    typeof environment.compilerOptions.target,
    monaco.typescript.ScriptTarget
  >;
  // Semantic checks stay on for the whole program: the other side may have its types. A session without them drops its
  // own files' missing-declaration markers instead, below.
  const diagnosticsOptions = {
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: false,
  };
  /**
   * Gives Monaco the module `paths` and `typeRoots` of `sessionEnvironment`. An isolated session's `paths` are always
   * empty, so a later call changes them only in a one-version session whose declarations loaded after all.
   */
  const applyLanguageOptions = (sessionEnvironment: ProjectTypeEnvironment) => {
    const compilerOptions = {
      target: monacoTargets[sessionEnvironment.compilerOptions.target],
      lib: monacoLibraries.files,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      strict: true,
      noEmit: true,
      allowNonTsExtensions: true,
      allowImportingTsExtensions: true,
      resolveJsonModule: true,
      isolatedModules: true,
      skipLibCheck: true,
      jsx: ts.JsxEmit.Preserve,
      paths: Object.fromEntries(
        Object.entries(sessionEnvironment.compilerOptions.paths).map(([key, paths]) => [key, [...paths]]),
      ),
    };

    for (const typeRoot of sessionEnvironment.compilerOptions.typeRoots ?? []) {
      sessionTypeRoots.add(typeRoot);
    }

    const typeRoots = [...sessionTypeRoots];

    setLanguageOptions(
      ts.typescriptDefaults,
      typeRoots.length === 0 ? compilerOptions : { ...compilerOptions, typeRoots },
      diagnosticsOptions,
    );
    setLanguageOptions(
      ts.javascriptDefaults,
      {
        ...compilerOptions,
        ...(typeRoots.length === 0 ? {} : { typeRoots }),
        allowJs: true,
        checkJs: true,
      },
      diagnosticsOptions,
    );
  };

  applyLanguageOptions(environment);
  registerPrettierFormatting();
  const libraries: monaco.IDisposable[] = [];
  const libraryUris = new Set<string>();
  const models = new Map<string, monaco.editor.ITextModel>();
  const listeners: monaco.IDisposable[] = [];
  const views = new Map<string, monaco.editor.ICodeEditorViewState>();
  let editor: monaco.editor.IStandaloneCodeEditor | undefined;
  let runNotes: ReturnType<typeof createRunNotesLayer> | undefined;
  let selected: string | undefined;
  let layoutText: EditorText = EDITOR_TEXT.desktop;
  let preferredFontSize: EditorFontSize | null = null;
  const applyText = () => editor?.updateOptions(resolveEditorText(layoutText, preferredFontSize));
  /** Gives Monaco the declaration and stub files of `sessionEnvironment` it does not have yet. */
  const addLibraryFiles = (sessionEnvironment: ProjectTypeEnvironment) => {
    for (const file of sessionEnvironment.files) {
      if (file.kind !== "project" && !libraryUris.has(file.uri)) {
        libraryUris.add(file.uri);
        libraries.push(ts.typescriptDefaults.addExtraLib(file.content, file.uri));
        libraries.push(ts.javascriptDefaults.addExtraLib(file.content, file.uri));
      }
    }
  };
  const readSources = () => [...models.values()].map((model) => model.getValue());
  /**
   * Loads the declarations of packages an edit newly imports, such as `zod` after `import { z } from "zod"`. Monaco
   * checks the files again once their libraries change. Runs one load at a time, so each builds on the last.
   */
  const importScan = createActor(
    createImportScanMachine<ProjectTypeEnvironment | undefined>({
      readImportKey: () => toImportKey(readSources()),
      loadImports: async () => {
        const sources = readSources();
        const importKey = toImportKey(sources);

        if (liveInputs === null) {
          return { importKey, loaded: undefined };
        }

        return {
          importKey,
          loaded: await addImportedLibraries(liveInputs.generatedEnvironment, liveInputs.manifest, sources),
        };
      },
      applyImports: (next) => {
        if (liveInputs === null || next === undefined || next === liveInputs.generatedEnvironment) {
          return;
        }

        const sessionEnvironment = toSessionEnvironment(next);
        liveInputs.generatedEnvironment = next;
        // Set first: a changed option restarts the TypeScript worker, which then starts with every library rather than
        // receiving the new ones twice.
        applyLanguageOptions(sessionEnvironment);
        addLibraryFiles(sessionEnvironment);
      },
      reportFailure: (cause) => console.error("Could not load the declarations of a new import", cause),
    }),
  ).start();
  const dispose = () => {
    liveInputs = null;
    importScan.send({ type: "scan.dispose" });
    runNotes?.dispose();
    runNotes = undefined;
    editor?.dispose();
    listeners.forEach((item) => item.dispose());
    models.forEach((model) => model.dispose());
    libraries.forEach((item) => item.dispose());

    // Monaco makes a model of a declaration file it shows, such as an error's related location, and never frees it.
    const sessionLibraryUris = new Set([...libraryUris].map((uri) => monaco.Uri.parse(uri).toString()));

    for (const model of monaco.editor.getModels()) {
      if (sessionLibraryUris.has(model.uri.toString())) {
        model.dispose();
      }
    }

    slot.release();

    // Whatever still holds this session, such as a stale closure, must not keep its models and view states alive.
    models.clear();
    views.clear();
    listeners.length = 0;
    libraries.length = 0;
    libraryUris.clear();
    editor = undefined;
  };

  try {
    // The slot keeps one side's lib from going away with the other side's editor.
    for (const extraLib of monacoLibraries.extraLibs) {
      const uri = `file:///__drizzle_run_libs__/${slotId}/${extraLib.fileName}`;
      libraryUris.add(uri);
      libraries.push(ts.typescriptDefaults.addExtraLib(extraLib.content, uri));
      libraries.push(ts.javascriptDefaults.addExtraLib(extraLib.content, uri));
    }

    addLibraryFiles(environment);

    for (const file of environment.files) {
      if (file.kind === "project") {
        const path = decodeURIComponent(file.uri.split(`/${environment.fingerprint}/`)[1]);
        const model = monaco.editor.createModel(file.content, getEditorLanguage(path), monaco.Uri.parse(file.uri));
        models.set(path, model);
        listeners.push(
          model.onDidChangeContent(() => {
            liveInputs?.onEdit(path, model.getValue());
            importScan.send({ type: "sources.edited" });
          }),
        );
      }
    }

    importScan.send({ type: "imports.opened", importKey: toImportKey(readSources()) });

    selected = models.has(initialPath) ? initialPath : models.keys().next().value;
    listeners.push(watchMonacoTheme(monaco));
    editor = monaco.editor.create(host, {
      // Safari zooms focused inputs below 16px; keep the hidden input independent of the displayed code size.
      extraEditorClassName: "max-phone:[&_textarea.inputarea]:text-[16px]!",
      model: models.get(selected ?? "") ?? null,
      theme: getMonacoThemeName(document.documentElement.dataset.theme),
      automaticLayout: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim(),
      ...EDITOR_TEXT.desktop,
      minimap: { enabled: false },
      padding: { top: 18 },
      scrollBeyondLastLine: false,
      renderLineHighlight: "none",
      tabSize: 2,
      ariaLabel: "Project TypeScript editor",
      fixedOverflowWidgets: true,
    });
    listeners.push(
      monaco.editor.registerEditorOpener({
        openCodeEditor(_source, resource, position) {
          const entry = [...models].find(([, model]) => model.uri.toString() === resource.toString());

          if (!entry || !editor) {
            return false;
          }

          const view = editor.saveViewState();

          if (selected && view) {
            views.set(selected, view);
          }

          editor.setModel(entry[1]);
          selected = entry[0];
          liveInputs?.onNavigate(entry[0]);

          if (position) {
            const location =
              "startLineNumber" in position
                ? { lineNumber: position.startLineNumber, column: position.startColumn }
                : position;
            editor.setPosition(location);
            editor.revealLineInCenter(location.lineNumber);
          }

          editor.focus();

          return true;
        },
      }),
    );

    if (signal.aborted) {
      throw new Error("Project changed during editor initialization");
    }

    runNotes = createRunNotesLayer(editor, models);

    let highlighted: { model: monaco.editor.ITextModel; ids: string[] } | undefined;
    const clearHighlight = () => {
      if (highlighted && !highlighted.model.isDisposed()) {
        highlighted.model.deltaDecorations(highlighted.ids, []);
      }

      highlighted = undefined;
    };
    let errorLine: { model: monaco.editor.ITextModel; ids: string[]; message: string } | undefined;
    let errorZone: { id: string; pill: HTMLElement; indentPx: number } | undefined;
    /** Keeps a long message inside the visible code, ending in an ellipsis. */
    const fitErrorPill = () => {
      if (editor && errorZone) {
        const widthPx = editor.getLayoutInfo().contentWidth - errorZone.indentPx - 24;
        errorZone.pill.style.maxWidth = `${Math.max(widthPx, 120)}px`;
      }
    };
    const removeErrorZone = () => {
      const zone = errorZone;
      errorZone = undefined;

      if (zone !== undefined) {
        editor?.changeViewZones((zones) => zones.removeZone(zone.id));
      }
    };
    /**
     * Puts the run's message under its line, at the line's indent, while the editor shows that file. Monaco drops
     * view zones when the model changes and the indent depends on the font, so this runs again on both.
     */
    const placeErrorZone = () => {
      removeErrorZone();
      const range =
        errorLine && !errorLine.model.isDisposed() ? errorLine.model.getDecorationRange(errorLine.ids[0]) : null;

      if (!editor || !errorLine || !range || editor.getModel() !== errorLine.model) {
        return;
      }

      const line = range.startLineNumber;
      const { spaceWidth } = editor.getOption(monaco.editor.EditorOption.fontInfo);
      const indentPx = getIndentColumns(errorLine.model, line) * spaceWidth;
      const pill = document.createElement("span");
      pill.className = "run-error-pill";
      pill.textContent = errorLine.message.split("\n", 1)[0];
      pill.title = errorLine.message;
      const domNode = document.createElement("div");
      domNode.className = "run-error-zone";
      domNode.style.paddingLeft = `${indentPx}px`;
      domNode.append(pill);
      const marginDomNode = document.createElement("div");
      marginDomNode.className = "run-error-zone";

      editor.changeViewZones((zones) => {
        const id = zones.addZone({ afterLineNumber: line, heightInPx: 26, domNode, marginDomNode });
        errorZone = { id, pill, indentPx };
      });
      fitErrorPill();
    };
    const clearErrorLine = () => {
      removeErrorZone();

      if (errorLine && !errorLine.model.isDisposed()) {
        errorLine.model.deltaDecorations(errorLine.ids, []);
      }

      errorLine = undefined;
    };

    listeners.push(
      // A disposed session must not keep the decorated models or the error pill alive for whatever still holds it.
      {
        dispose: () => {
          highlighted = undefined;
          errorLine = undefined;
          errorZone = undefined;
        },
      },
      editor.onDidChangeModel(placeErrorZone),
      editor.onDidLayoutChange(fitErrorPill),
      editor.onDidChangeConfiguration((event) => {
        if (event.hasChanged(monaco.editor.EditorOption.fontInfo)) {
          placeErrorZone();
        }
      }),
    );
    const show = (path: string) => {
      const model = models.get(path);

      if (!model || !editor || selected === path) {
        return model;
      }

      const view = editor.saveViewState();

      if (selected && view) {
        views.set(selected, view);
      }

      editor.setModel(model);
      selected = path;
      editor.restoreViewState(views.get(path) ?? null);

      return model;
    };

    return {
      dispose,
      /**
       * Writes new contents as one undoable edit per changed file. Files the editor does not have are left to the next
       * preparation.
       */
      replaceFiles: (files: Readonly<Record<string, string>>) => {
        for (const [path, model] of models) {
          const content = files[path];

          if (content !== undefined) {
            replaceModelText(model, content);
          }
        }
      },
      /**
       * Opens a file without taking focus, and marks its line range and scrolls to it when one is given. With
       * `open: false`, it marks the lines and leaves the shown file as it is.
       */
      highlight: (
        path: string,
        lines?: readonly [startLine: number, endLine: number],
        { open = true }: { open?: boolean } = {},
      ) => {
        clearHighlight();
        const model = open ? show(path) : models.get(path);

        if (!model || !editor || lines === undefined) {
          return;
        }

        const [startLine, endLine] = lines;

        const last = Math.min(endLine, model.getLineCount());
        const ids = model.deltaDecorations(
          [],
          [
            {
              range: new monaco.Range(startLine, 1, last, model.getLineMaxColumn(last)),
              options: {
                isWholeLine: true,
                className: "guide-highlight",
                linesDecorationsClassName: "guide-highlight-gutter",
                stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
              },
            },
          ],
        );

        highlighted = { model, ids };

        if (open) {
          editor.revealLinesInCenter(startLine, last);
        }
      },
      /**
       * Bands the line a run failed on, with its message under it, without opening its file. Monaco moves the band
       * with later edits.
       */
      markError: (location: { path: string; line: number; message: string } | undefined) => {
        clearErrorLine();
        const model = location && models.get(location.path);

        if (!location || !model || location.line > model.getLineCount()) {
          return;
        }

        const ids = model.deltaDecorations(
          [],
          [
            {
              range: new monaco.Range(location.line, 1, location.line, model.getLineMaxColumn(location.line)),
              options: {
                isWholeLine: true,
                className: "run-error-line",
                marginClassName: "run-error-line",
                lineNumberClassName: "run-error-line-number",
              },
            },
          ],
        );

        errorLine = { model, ids, message: location.message };
        placeErrorZone();
      },
      /**
       * Calls `listener` each time TypeScript's marks in the project's files change, such as after an edit or once the
       * first check ends. Returns the call that stops it.
       */
      onProblemsChange: (listener: () => void) => {
        const subscription = monaco.editor.onDidChangeMarkers((resources) => {
          const changed = new Set(resources.map((resource) => resource.toString()));

          if ([...models.values()].some((model) => changed.has(model.uri.toString()))) {
            listener();
          }
        });

        return () => subscription.dispose();
      },
      /** The errors and warnings TypeScript marks in the project's files, for the AI chat's get_problems and the tabs. */
      problems: () => {
        return [...models].flatMap(([path, model]) =>
          monaco.editor
            .getModelMarkers({ resource: model.uri })
            .filter((marker) => marker.severity >= monaco.MarkerSeverity.Warning)
            .map((marker) => ({
              path,
              line: marker.startLineNumber,
              column: marker.startColumn,
              severity: marker.severity >= monaco.MarkerSeverity.Error ? ("error" as const) : ("warning" as const),
              message: marker.message,
            })),
        );
      },
      /**
       * Formats the project's TypeScript and JavaScript files with Prettier, unless the editor is read-only. Each
       * change reaches `onEdit` before this settles, so a run started after it reads the formatted files. Nothing
       * changes once `formatSignal` aborts.
       */
      formatFiles: (formatSignal?: AbortSignal, { skip }: { skip?: ReadonlySet<string> } = {}) =>
        editor
          ? formatEditorFiles(
              editor,
              [...models].filter(([path]) => skip?.has(path) !== true).map(([, model]) => model),
              formatSignal,
            )
          : Promise.resolve(),
      /** Locks the files while a guide owns the edits; `message` shows when someone types. */
      setReadOnly: (readOnly: boolean, message: string) => {
        editor?.updateOptions({ readOnly, readOnlyMessage: { value: message } });
      },
      /**
       * Draws the shown run's and guide step's notes in the code, such as "committed · 4 queries" after a
       * transaction's line, in place of the ones before.
       */
      setRunNotes: (next: readonly RunNote[]) => runNotes?.set(next),
      /** Apply phone text sizing and horizontal scrolling for long lines. */
      setPhoneLayout: (phone: boolean) => {
        layoutText = phone ? EDITOR_TEXT.phone : EDITOR_TEXT.desktop;
        applyText();
        runNotes?.setPhone(phone);
      },
      /** Sets code at another size, such as a side-by-side pane's 12.5/22 px. */
      setTextSize: (fontSize: number, lineHeight: number) => {
        layoutText = { fontSize, lineHeight };
        applyText();
      },
      /** Sets code at the size the viewer picked, over the layout's; `null` returns to the layout's size. */
      setPreferredFontSize: (size: EditorFontSize | null) => {
        preferredFontSize = size;
        applyText();
      },
      /** Wrap long lines at the editor's width. */
      setWordWrap: (wrap: boolean) => {
        editor?.updateOptions({ wordWrap: wrap ? "on" : "off", wrappingIndent: "none" });
      },
      select: (path: string, line?: number, column?: number) => {
        const model = show(path);

        if (!model || !editor) {
          return;
        }

        if (line !== undefined) {
          editor.setPosition({ lineNumber: line, column: column ?? 1 });
          editor.revealLineInCenter(line);
          editor.focus();
        }
      },
    };
  } catch (cause) {
    dispose();
    throw cause;
  }
}

/**
 * Colorize code
 *
 * Returns the code as HTML colored by Monaco's tokenizer in the current editor theme, for read-only
 * code outside an editor such as a chat reply. A language Monaco does not know comes back uncolored.
 * The HTML only holds its colors while that theme stays set: color it again after the theme changes.
 */
export function colorizeCode(code: string, language: string): Promise<string> {
  // No editor may be open yet to have set the theme, and Monaco's default one paints other colors.
  applyMonacoTheme(monaco);

  return monaco.editor.colorize(code, language, { tabSize: 2 });
}
