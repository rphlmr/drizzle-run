import * as monaco from "monaco-editor";

import type { RunNote, RunNoteTone } from "../ui/run-notes";

const toneClasses: Record<RunNoteTone, string> = {
  ok: "run-note-ok",
  err: "run-note-err",
  plain: "run-note-plain",
};

// Monaco's sticky scroll header copies a line's chip only when it re-renders after the notes land, so the header
// never shows one.
const endOfLineChip = "run-note-chip in-[.sticky-widget]:hidden";

/** A note with the decoration that keeps its line as the code around it changes. */
interface AnchoredNote {
  note: RunNote;
  model: monaco.editor.ITextModel;
  id: string;
}

function createElement(tag: string, className: string, text?: string) {
  const element = document.createElement(tag);
  element.className = className;

  if (text !== undefined) {
    element.textContent = text;
  }

  return element;
}

function createChip(text: string, toneClass: string) {
  return createElement("span", `run-note-chip ${toneClass}`, text);
}

function getAnchorLine(note: RunNote) {
  return note.kind === "removed" || note.kind === "separator" ? Math.max(note.afterLine, 1) : note.line;
}

/** How many columns a line's leading whitespace spans, a tab reaching the next tab stop; 0 for a blank line. */
export function getIndentColumns(model: monaco.editor.ITextModel, line: number): number {
  const { tabSize } = model.getOptions();
  const first = model.getLineFirstNonWhitespaceColumn(line);
  let columns = 0;

  for (const character of model.getLineContent(line).slice(0, Math.max(first - 1, 0))) {
    columns = character === "\t" ? columns + tabSize - (columns % tabSize) : columns + 1;
  }

  return columns;
}

/**
 * Run notes in the code
 *
 * Draws the notes of the shown run and guide step in the editor. Chips sit after their line on desktop, as text
 * injected after the line's end that moves with it while it is edited, and under it on phones; removed lines and
 * separators are view zones. Notes are only added or removed when the notes change, never while typing, so the code
 * does not shift under the cursor. Monaco drops zones when the model changes, and their sizes depend on the font, so
 * the notes of the shown file are placed again on both.
 */
export function createRunNotesLayer(
  editor: monaco.editor.ICodeEditor,
  models: ReadonlyMap<string, monaco.editor.ITextModel>,
) {
  let anchored: AnchoredNote[] = [];
  let zones: string[] = [];
  let endOfLine: { model: monaco.editor.ITextModel; ids: string[] }[] = [];
  let phone = false;

  const removePlaced = () => {
    const placedZones = zones;
    zones = [];
    editor.changeViewZones((accessor) => placedZones.forEach((id) => accessor.removeZone(id)));

    for (const { model, ids } of endOfLine) {
      if (!model.isDisposed()) {
        model.deltaDecorations(ids, []);
      }
    }

    endOfLine = [];
  };

  const addZone = (afterLineNumber: number, heightInPx: number, domNode: HTMLElement, marginDomNode?: HTMLElement) => {
    let id = "";
    editor.changeViewZones((accessor) => {
      id = accessor.addZone({ afterLineNumber, heightInPx, domNode, marginDomNode });
      zones.push(id);
    });

    return id;
  };

  /**
   * Puts a chip after its line's last character as injected text, so it flows with the line and scrolls with it.
   * The time is a second part of the same pill on the same range, which Monaco draws in insertion order, so the
   * screenshot suite can hide it.
   */
  const addEndOfLineChip = ({ model, id }: AnchoredNote, note: Extract<RunNote, { kind: "chip" }>) => {
    const range = model.getDecorationRange(id);

    if (!range) {
      return;
    }

    const line = new monaco.Range(
      range.startLineNumber,
      1,
      range.startLineNumber,
      model.getLineMaxColumn(range.startLineNumber),
    );
    const tone = toneClasses[note.tone];
    const stickiness = monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges;
    const parts: monaco.editor.IModelDeltaDecoration[] = [
      {
        range: line,
        options: {
          stickiness,
          after: {
            content: note.text,
            inlineClassName: `${endOfLineChip} run-note-eol ${tone}${note.detail === undefined ? "" : " run-note-joined"}`,
          },
        },
      },
    ];

    if (note.detail !== undefined) {
      parts.push({
        range: line,
        options: {
          stickiness,
          after: { content: ` · ${note.detail}`, inlineClassName: `${endOfLineChip} run-note-detail ${tone}` },
        },
      });
    }

    endOfLine.push({ model, ids: model.deltaDecorations([], parts) });
  };

  const placeNote = (entry: AnchoredNote) => {
    const { note, model } = entry;
    const range = model.getDecorationRange(entry.id);

    if (!range) {
      return;
    }

    const line = range.startLineNumber;
    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
    const { spaceWidth } = editor.getOption(monaco.editor.EditorOption.fontInfo);
    const indentPx = getIndentColumns(model, line) * spaceWidth;
    const underLine = (height: number, ...children: (HTMLElement | string)[]) => {
      const domNode = createElement("div", "run-note-zone");
      domNode.style.paddingLeft = `${indentPx}px`;
      domNode.append(...children);
      addZone(line, height, domNode);
    };

    switch (note.kind) {
      case "chip":
        if (phone) {
          underLine(26, createChip(note.text, toneClasses[note.tone]));
        } else {
          addEndOfLineChip(entry, note);
        }

        return;

      case "removed": {
        const { fontFamily, fontSize } = editor.getOption(monaco.editor.EditorOption.fontInfo);
        const domNode = createElement("div", "run-note-removed");
        const marginDomNode = createElement("div", "run-note-removed");
        domNode.style.fontFamily = fontFamily;
        domNode.style.fontSize = `${fontSize}px`;
        domNode.style.lineHeight = `${lineHeight}px`;
        marginDomNode.style.fontFamily = fontFamily;
        marginDomNode.style.fontSize = `${fontSize}px`;
        marginDomNode.style.lineHeight = `${lineHeight}px`;

        for (const [index, text] of note.lines.entries()) {
          const row = createElement("div", "");
          const struck = createElement("span", "run-note-removed-text", text);
          row.append(struck);

          void monaco.editor
            .colorize(text, model.getLanguageId(), { tabSize: model.getOptions().tabSize })
            .then((html) => {
              struck.innerHTML = html.replace(/<br\/?>$/, "");
            });

          if (index === 0) {
            row.append(createChip(note.label, "run-note-removed-pill"));
          }

          domNode.append(row);

          const layout = editor.getLayoutInfo();
          const number = createElement("div", "run-note-removed-number", `${note.firstLine + index} −`);
          number.style.width = `${layout.lineNumbersLeft + layout.lineNumbersWidth}px`;
          marginDomNode.append(number);
        }

        addZone(note.afterLine === 0 ? 0 : line, lineHeight * note.lines.length, domNode, marginDomNode);

        return;
      }

      case "separator": {
        const domNode = createElement("div", "run-note-separator");
        const chip = createChip(note.label, "run-note-lime");
        chip.style.position = "relative";
        chip.style.marginLeft = "36px";
        domNode.append(chip);
        addZone(note.afterLine === 0 ? 0 : line, 22, domNode);
      }
    }
  };

  /** Places the shown file's notes, after removing what was placed before. */
  const place = () => {
    removePlaced();
    const model = editor.getModel();

    for (const entry of anchored) {
      if (entry.model === model && !model.isDisposed()) {
        placeNote(entry);
      }
    }
  };

  const clear = () => {
    removePlaced();

    for (const { model, id } of anchored) {
      if (!model.isDisposed()) {
        model.deltaDecorations([id], []);
      }
    }

    anchored = [];
  };

  const listeners = [
    editor.onDidChangeModel(place),
    editor.onDidChangeConfiguration((event) => {
      if (
        event.hasChanged(monaco.editor.EditorOption.fontInfo) ||
        event.hasChanged(monaco.editor.EditorOption.lineHeight)
      ) {
        place();
      }
    }),
  ];

  return {
    /** Shows these notes in place of the ones before; notes on files or lines the editor does not have are left out. */
    set: (notes: readonly RunNote[]) => {
      clear();

      for (const note of notes) {
        const model = models.get(note.path);
        const line = getAnchorLine(note);

        if (!model || line > model.getLineCount()) {
          continue;
        }

        const range = new monaco.Range(line, 1, line, 1);
        const [id] = model.deltaDecorations(
          [],
          [
            {
              range,
              options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
            },
          ],
        );

        if (id !== undefined) {
          anchored.push({ note, model, id });
        }
      }

      place();
    },
    /** Phones put chips under their line and leave console output to the Logs tab. */
    setPhone: (next: boolean) => {
      if (phone !== next) {
        phone = next;
        place();
      }
    },
    dispose: () => {
      clear();
      listeners.forEach((listener) => listener.dispose());
    },
  };
}
