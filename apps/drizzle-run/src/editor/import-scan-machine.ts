import { assign, fromPromise, setup } from "xstate";

import { declareType } from "../lib/declare-type";

/** How long the scan waits after the last edit before it reads the files' imports. */
export const IMPORT_SCAN_DELAY_MS = 300;

/** What the import scan reads and changes in the editor session. */
export interface ImportScanPorts<Loaded> {
  /** The packages the files import now, as one comparable string. */
  readImportKey(): string;
  /** Loads the declarations of the packages the files import, with the import key it read them for. */
  loadImports(): Promise<{ importKey: string; loaded: Loaded }>;
  /** Gives the editor what a load produced. Runs only while the scan is not disposed. */
  applyImports(loaded: Loaded): void;
  reportFailure(cause: unknown): void;
}

/** The imports the session opened with, an edit to a project file, or the session closing. */
export type ImportScanEvent =
  | { type: "imports.opened"; importKey: string }
  | { type: "sources.edited" }
  | { type: "scan.dispose" };

/**
 * Build the editor's import scan machine
 *
 * `idle` until an edit, then `debouncing` until edits pause for `IMPORT_SCAN_DELAY_MS`. A scan whose imports changed
 * since the last load goes to `loading`, one load at a time; an edit meanwhile scans again once it lands. A failed load
 * leaves the imports unscanned, so the next edit tries again. `disposed` ignores a load still in flight.
 */
export function createImportScanMachine<Loaded>(ports: ImportScanPorts<Loaded>) {
  return setup({
    types: {
      context: declareType<{ scannedImportKey: string; isEditedWhileLoading: boolean }>(),
      events: declareType<ImportScanEvent>(),
    },
    actors: {
      loadImports: fromPromise(() => ports.loadImports()),
    },
    guards: {
      isScanned: ({ context }) => ports.readImportKey() === context.scannedImportKey,
      isEditedWhileLoading: ({ context }) => context.isEditedWhileLoading,
    },
  }).createMachine({
    id: "importScan",
    initial: "idle",
    context: { scannedImportKey: "", isEditedWhileLoading: false },
    on: { "scan.dispose": ".disposed" },
    states: {
      idle: {
        on: {
          "imports.opened": { actions: assign({ scannedImportKey: ({ event }) => event.importKey }) },
          "sources.edited": "debouncing",
        },
      },
      debouncing: {
        on: { "sources.edited": { target: "debouncing", reenter: true } },
        after: {
          [IMPORT_SCAN_DELAY_MS]: [{ guard: "isScanned", target: "idle" }, { target: "loading" }],
        },
      },
      loading: {
        on: { "sources.edited": { actions: assign({ isEditedWhileLoading: true }) } },
        invoke: {
          src: "loadImports",
          onDone: {
            target: "loaded",
            actions: [
              assign({ scannedImportKey: ({ event }) => event.output.importKey }),
              ({ event }) => ports.applyImports(event.output.loaded),
            ],
          },
          onError: { target: "loaded", actions: ({ event }) => ports.reportFailure(event.error) },
        },
      },
      loaded: {
        exit: assign({ isEditedWhileLoading: false }),
        always: [{ guard: "isEditedWhileLoading", target: "debouncing" }, { target: "idle" }],
      },
      disposed: { type: "final" },
    },
  });
}
