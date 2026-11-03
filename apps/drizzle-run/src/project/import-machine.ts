import { assign, emit, fromPromise, setup } from "xstate";
import * as z from "zod/mini";

import { declareType } from "../lib/declare-type";
import { getErrorText } from "../lib/error-text";
import { readShareLinkRecord, type ShareLinkRecord } from "../store/storage";
import { importProjectValue, readProjectJson, RetiredProjectImportError, type ProjectFileFormat } from "./project-file";
import type { ProjectRecord, RetiredProjectImport } from "./projects";

/** Project files above this size are refused before they are read. */
export const PROJECT_IMPORT_LIMIT = 2_097_152;

/** A project read from an export file. */
export interface ParsedImport {
  project: ProjectRecord;
  /** Present when the export was made with "Include share links". */
  shareLink: ShareLinkRecord | undefined;
  /** Says the project moved off a release Drizzle Run no longer ships. */
  releaseNote?: string;
}

/** A project of the file on pairs Drizzle Run no longer ships, added once a release is chosen for it. */
export interface QueuedRetiredImport extends RetiredProjectImport {
  /** Present when the export was made with "Include share links": restored once the project is added. */
  shareLink: ShareLinkRecord | undefined;
  /** A project file on its own opens once added; a backup's projects join the list. */
  opens: boolean;
}

const ExportedShareLinkSchema = z.object({ shareLink: z.optional(z.unknown()) });

/** Only a project export carries a share link: one in any other file, such as someone else's snapshot, is dropped. */
function readExportedShareLink(value: unknown, format: ProjectFileFormat): ShareLinkRecord | undefined {
  if (format !== "project") {
    return undefined;
  }

  const exported = ExportedShareLinkSchema.safeParse(value);

  return exported.success ? readShareLinkRecord(exported.data.shareLink) : undefined;
}

function toQueuedRetiredImport(cause: RetiredProjectImportError, value: unknown, opens: boolean): QueuedRetiredImport {
  return { ...cause.retired, shareLink: readExportedShareLink(value, cause.format), opens };
}

/** A validation error's first issue, and how many more it lists: a full list of issues reads as noise in a banner. */
function toImportErrorText(cause: unknown) {
  const [first = "", ...rest] = getErrorText(cause).split("\n");

  if (rest.length === 0) {
    return first;
  }

  return `${first} (and ${rest.length} more ${rest.length === 1 ? "problem" : "problems"})`;
}

function parseProjectValue(value: unknown): ParsedImport {
  const { project, format, releaseNote } = importProjectValue(value);
  const note = releaseNote === undefined ? {} : { releaseNote };

  return { project, shareLink: readExportedShareLink(value, format), ...note };
}

/** The projects a file holds, and why any of a backup's projects were left out. */
export interface ParsedProjectFile {
  parsed: ParsedImport[];
  /** One line per project of a backup that could not be read, such as "Project 2 of 3 could not be read: ...". */
  skipped: string[];
  /** Projects on pairs Drizzle Run no longer ships: the host asks for a release before adding each. */
  retired: QueuedRetiredImport[];
  /** A project file on its own opens once added; a backup's projects join the list, however few were readable. */
  opens: boolean;
}

/** What the host's `save` adds: the parsed projects, and whether the one project of a single-project file opens. */
export interface ProjectImportSave {
  projects: readonly ProjectRecord[];
  opens: boolean;
}

/**
 * Parse a project file, and find the share links an export may carry
 *
 * A backup from "Export all" or "Export selected" is a list of projects: the readable ones are imported and the others
 * are listed in `skipped`, so one damaged project does not hold back the rest. A file with no readable project throws.
 * Only a project export restores a share link: one in any other file, such as someone else's snapshot, is dropped.
 */
export function parseProjectFile(text: string): ParsedProjectFile {
  const value = readProjectJson(text);

  if (!Array.isArray(value)) {
    try {
      return { parsed: [parseProjectValue(value)], skipped: [], retired: [], opens: true };
    } catch (cause) {
      if (cause instanceof RetiredProjectImportError) {
        return { parsed: [], skipped: [], retired: [toQueuedRetiredImport(cause, value, true)], opens: true };
      }

      throw cause;
    }
  }

  if (value.length === 0) {
    throw new Error("This backup holds no projects.");
  }

  const parsed: ParsedImport[] = [];
  const skipped: string[] = [];
  const retired: QueuedRetiredImport[] = [];

  for (const [index, item] of value.entries()) {
    try {
      parsed.push(parseProjectValue(item));
    } catch (cause) {
      if (cause instanceof RetiredProjectImportError) {
        retired.push(toQueuedRetiredImport(cause, item, false));
        continue;
      }

      skipped.push(`Project ${index + 1} of ${value.length} could not be read: ${toImportErrorText(cause)}`);
    }
  }

  if (parsed.length === 0 && retired.length === 0) {
    throw new Error(`No project in this backup could be read. ${skipped.join(" ")}`);
  }

  return { parsed, skipped, retired, opens: false };
}

interface ProjectImportContext {
  file: File | undefined;
  text: string;
  parsed: ParsedImport[] | undefined;
  skipped: string[];
  retired: QueuedRetiredImport[];
  opens: boolean;
  error: string;
}

/** What the import UI sends: a picked file, Retry or Dismiss. */
export type ProjectImportEvent =
  | { type: "file.pick"; file: File }
  | { type: "import.retry" }
  | { type: "import.dismiss" };

/**
 * What the import machine reports once a file is saved or has failed
 *
 * `projects` are the ones added. `skipped` lists a backup's unreadable projects, `retired` the ones still to add once a
 * release is chosen, and `releaseNotes` the projects that moved off a release Drizzle Run no longer ships.
 */
export type ProjectImportEmitted =
  | {
      type: "import.done";
      projects: readonly ProjectRecord[];
      skipped: string[];
      retired: QueuedRetiredImport[];
      releaseNotes: string[];
    }
  | { type: "import.failed"; error: string };

/** A share link to restore for an imported project. */
export interface RestoredShareKey {
  projectId: string;
  link: ShareLinkRecord;
}

/**
 * Pick, read (size limit), parse, restore the share links, save, done.
 * Storage and the project list are injected: `restoreShareKey` and `save` come from the host.
 */
export const projectImportMachine = setup({
  types: {
    context: declareType<ProjectImportContext>(),
    events: declareType<ProjectImportEvent>(),
    emitted: declareType<ProjectImportEmitted>(),
  },
  actors: {
    read: fromPromise<string, File>(({ input }) => input.text()),
    parse: fromPromise<ParsedProjectFile, string>(async ({ input }) => parseProjectFile(input)),
    restoreShareKey: fromPromise<void, readonly RestoredShareKey[]>(async () => {
      throw new Error("Project import needs a restoreShareKey service.");
    }),
    save: fromPromise<void, ProjectImportSave>(async () => {
      throw new Error("Project import needs a save service.");
    }),
  },
  guards: {
    tooLarge: ({ event }) => event.type === "file.pick" && event.file.size > PROJECT_IMPORT_LIMIT,
  },
}).createMachine({
  id: "projectImport",
  initial: "idle",
  context: { file: undefined, text: "", parsed: undefined, skipped: [], retired: [], opens: false, error: "" },
  states: {
    idle: {
      on: {
        "file.pick": [
          {
            guard: "tooLarge",
            target: "failed",
            actions: assign({ file: undefined, error: "Import must be smaller than 2 MB." }),
          },
          {
            target: "reading",
            actions: assign({
              file: ({ event }) => event.file,
              text: "",
              parsed: undefined,
              skipped: [],
              retired: [],
              error: "",
            }),
          },
        ],
      },
    },
    reading: {
      invoke: {
        src: "read",
        input: ({ context }) => {
          if (!context.file) {
            throw new Error("No project file was picked.");
          }

          return context.file;
        },
        onDone: { target: "parsing", actions: assign({ text: ({ event }) => event.output }) },
        onError: { target: "failed", actions: assign({ error: ({ event }) => getErrorText(event.error) }) },
      },
    },
    parsing: {
      invoke: {
        src: "parse",
        input: ({ context }) => context.text,
        onDone: [
          {
            guard: ({ event }) => event.output.parsed.some((item) => item.shareLink !== undefined),
            target: "restoringKey",
            actions: assign(({ event }) => event.output),
          },
          { target: "saving", actions: assign(({ event }) => event.output) },
        ],
        onError: { target: "failed", actions: assign({ error: ({ event }) => toImportErrorText(event.error) }) },
      },
    },
    restoringKey: {
      invoke: {
        src: "restoreShareKey",
        input: ({ context }) =>
          (context.parsed ?? []).flatMap(({ project, shareLink }) =>
            shareLink === undefined ? [] : [{ projectId: project.id, link: shareLink }],
          ),
        onDone: "saving",
        onError: { target: "failed", actions: assign({ error: ({ event }) => getErrorText(event.error) }) },
      },
    },
    saving: {
      invoke: {
        src: "save",
        input: ({ context }): ProjectImportSave => {
          if (!context.parsed) {
            throw new Error("No parsed project to save.");
          }

          return { projects: context.parsed.map((item) => item.project), opens: context.opens };
        },
        onDone: {
          target: "idle",
          actions: [
            emit(({ context }): ProjectImportEmitted => {
              if (!context.parsed) {
                return { type: "import.failed", error: "No parsed project to save." };
              }

              return {
                type: "import.done",
                projects: context.parsed.map((item) => item.project),
                skipped: context.skipped,
                retired: context.retired,
                releaseNotes: context.parsed.flatMap((item) =>
                  item.releaseNote === undefined ? [] : [item.releaseNote],
                ),
              };
            }),
            assign({ file: undefined, text: "", parsed: undefined, skipped: [], retired: [] }),
          ],
        },
        onError: { target: "failed", actions: assign({ error: ({ event }) => getErrorText(event.error) }) },
      },
    },
    failed: {
      entry: emit(({ context }): ProjectImportEmitted => ({ type: "import.failed", error: context.error })),
      on: {
        "file.pick": [
          {
            guard: "tooLarge",
            target: "failed",
            reenter: true,
            actions: assign({ file: undefined, error: "Import must be smaller than 2 MB." }),
          },
          {
            target: "reading",
            actions: assign({
              file: ({ event }) => event.file,
              text: "",
              parsed: undefined,
              skipped: [],
              retired: [],
              error: "",
            }),
          },
        ],
        "import.retry": {
          guard: ({ context }) => context.file !== undefined,
          target: "reading",
          actions: assign({ text: "", parsed: undefined, skipped: [], retired: [], error: "" }),
        },
        "import.dismiss": {
          target: "idle",
          actions: assign({ file: undefined, text: "", parsed: undefined, skipped: [], retired: [], error: "" }),
        },
      },
    },
  },
});
