import * as monaco from "monaco-editor";

const FORMAT_ACTION = "editor.action.formatDocument";

/**
 * Format code with Prettier
 *
 * Prettier and its TypeScript parser load on the first format, so the editor does not pay for them up front. The
 * TypeScript parser reads JavaScript too. Code Prettier cannot parse, such as a half-typed line, comes back as
 * `undefined`: the editor already marks the error.
 */
export async function formatCode(code: string): Promise<string | undefined> {
  const [prettier, typescript, estree] = await Promise.all([
    import("prettier/standalone"),
    import("prettier/plugins/typescript"),
    import("prettier/plugins/estree"),
  ]);

  try {
    return await prettier.format(code, { parser: "typescript", plugins: [typescript, estree], printWidth: 120 });
  } catch {
    return undefined;
  }
}

let registered = false;

// The shown file's code as `formatEditorFiles` already formatted it, so Format Document applies it without formatting
// again in between, where a cancelled run could no longer stop it.
let preformatted: { code: string; formatted: string } | undefined;

/**
 * Make Prettier the editor's formatter
 *
 * Format Document, from the context menu or Shift+Alt+F, formats TypeScript and JavaScript files with Prettier. It
 * goes before TypeScript's own formatter, which Monaco only offers for a selection or when no document formatter
 * exists. Runs once per page.
 */
export function registerPrettierFormatting(): void {
  if (registered) {
    return;
  }

  registered = true;

  const provider: monaco.languages.DocumentFormattingEditProvider = {
    displayName: "Prettier",
    provideDocumentFormattingEdits: async (model) => {
      const code = model.getValue();
      const formatted = preformatted?.code === code ? preformatted.formatted : await formatCode(code);

      return formatted === undefined || formatted === code
        ? []
        : [{ range: model.getFullModelRange(), text: formatted }];
    },
  };

  monaco.languages.registerDocumentFormattingEditProvider("typescript", provider);
  monaco.languages.registerDocumentFormattingEditProvider("javascript", provider);
}

function isFormattable(model: monaco.editor.ITextModel) {
  const language = model.getLanguageId();

  return language === "typescript" || language === "javascript";
}

/**
 * Format an editor's files, such as before a run
 *
 * Every file is formatted before any changes, and nothing changes once `signal` aborts, such as when the run is
 * cancelled first. The shown file goes through Format Document, so the cursor keeps its place; each other file is
 * replaced whole, as one undo step. A read-only editor is left as it is, and so is a file edited while Prettier was
 * formatting it.
 */
export async function formatEditorFiles(
  editor: monaco.editor.ICodeEditor,
  models: Iterable<monaco.editor.ITextModel>,
  signal?: AbortSignal,
): Promise<void> {
  if (editor.getOption(monaco.editor.EditorOption.readOnly)) {
    return;
  }

  const shown = editor.getModel();
  const formattable = [...models].filter(isFormattable);
  const results = await Promise.all(
    formattable.map(async (model) => {
      const code = model.getValue();

      return { model, code, formatted: await formatCode(code) };
    }),
  );

  if (signal?.aborted) {
    return;
  }

  for (const { model, code, formatted } of results) {
    if (formatted === undefined || formatted === code || model.isDisposed() || model.getValue() !== code) {
      continue;
    }

    if (model !== shown) {
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: formatted }], () => null);
      continue;
    }

    preformatted = { code, formatted };

    try {
      await editor.getAction(FORMAT_ACTION)?.run();
    } finally {
      preformatted = undefined;
    }
  }
}

/**
 * Format the files the open editors show
 *
 * Read-only editors, such as a guide's while it runs, are left as they are.
 */
export async function formatOpenEditors(): Promise<void> {
  const editors = monaco.editor.getEditors().filter((editor) => !editor.getOption(monaco.editor.EditorOption.readOnly));

  await Promise.all(editors.map((editor) => editor.getAction(FORMAT_ACTION)?.run() ?? Promise.resolve()));
}
