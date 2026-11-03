import { assign, fromPromise, setup, type SnapshotFrom } from "xstate";

import { declareType } from "../lib/declare-type";
import { getErrorText } from "../lib/error-text";
import type { QueuedRetiredImport } from "../project/import-machine";
import type { ProjectRecord, RetiredPairProject } from "../project/projects";
import type { ShareLinkRecord } from "../store/storage";

/** The projects an export writes, and the shared links among them. */
export interface ProjectExport {
  projects: readonly ProjectRecord[];
  filename: string | undefined;
  links: ReadonlyMap<string, ShareLinkRecord>;
}

/** A project waiting for a release: a stored one on a removed pair, or an imported one. */
export type ReleaseChoice =
  | { kind: "stored"; project: RetiredPairProject }
  | { kind: "import"; project: QueuedRetiredImport };

/** What the imports since the banner was last dismissed did, apart from the projects still waiting for a release. */
interface ImportOutcome {
  added: number;
  declined: number;
  /** One line per project of a backup that could not be read. */
  skipped: readonly string[];
  releaseNotes: readonly string[];
}

/**
 * What an import did so far, kept until it is dismissed
 *
 * `pending` counts the imported projects the chooser still asks about; each answer moves one of them to `added` or
 * `declined`, so the banner follows the chooser.
 */
export interface ImportReport extends ImportOutcome {
  pending: number;
}

/** How the chooser was answered: a release was chosen, or the project waits (stored) or is left out (imported). */
export type ReleaseAnswer = "chosen" | "later";

/** What the workspace dialogs hear. */
export type WorkspaceDialogsEvent =
  | { type: "create.open" }
  | { type: "rename.open"; project: ProjectRecord }
  | { type: "delete.open"; projects: readonly ProjectRecord[] }
  | { type: "export.start"; projects: readonly ProjectRecord[]; filename?: string }
  | { type: "name.change"; name: string }
  | { type: "links.toggle"; include: boolean }
  | { type: "dialog.submit" }
  | { type: "dialog.close" }
  | {
      type: "import.done";
      added: number;
      retired: readonly QueuedRetiredImport[];
      skipped: readonly string[];
      releaseNotes: readonly string[];
    }
  | { type: "import_report.dismiss" }
  | { type: "releases.load"; stored: readonly RetiredPairProject[] }
  | { type: "release.answer"; id: string; answer: ReleaseAnswer };

interface WorkspaceDialogsContext {
  /** The projects the rename or delete dialog acts on. */
  projects: readonly ProjectRecord[];
  /** How many of the projects the delete dialog acts on have a share link, once the lookup answers. */
  sharedCount: number;
  /** The name typed in the rename dialog. */
  name: string;
  /** Why the open dialog's last submit failed; empty otherwise. */
  error: string;
  export: ProjectExport | undefined;
  includeLinks: boolean;
  /** Projects waiting for a release, in the order the chooser asks: stored ones first, then imports. */
  releases: readonly ReleaseChoice[];
  /** The import banner's counts; null once dismissed, or before the first import. */
  importOutcome: ImportOutcome | null;
}

/** The store work behind the dialogs; the app provides each one. */
export interface WorkspaceDialogsDependencies {
  renameProject: (input: { project: ProjectRecord; name: string }) => Promise<void>;
  deleteProjects: (input: { projects: readonly ProjectRecord[] }) => Promise<void>;
  /** The shared links among `projects`; a project whose link cannot be read has none. */
  findShareLinks: (input: { projects: readonly ProjectRecord[] }) => Promise<ReadonlyMap<string, ShareLinkRecord>>;
  writeExport: (input: ProjectExport & { includeLinks: boolean }) => void;
}

/**
 * Create the workspace dialogs machine
 *
 * ```text
 * dialogs:         closed ─► create | rename | delete | exportLookingUp ─(links)─► exportConfirm ─► closed
 * delete:          question (confirming ⇄ deleting) ∥ shareLinks (lookingUp ─► known)
 * releaseChooser:  waiting ─releases.load─► ready
 * ```
 *
 * One dialog at a time, each with its own error. Opening a dialog cancels an export lookup still going, so a late
 * lookup never opens its dialog over another one. An export with no shared link writes at once. The release chooser
 * asks about stored projects once the workspace loads, then about imports in the order they came. An import adds to the
 * report while earlier imports still wait for a release, and starts a new one otherwise.
 */
export function createWorkspaceDialogsMachine({
  renameProject,
  deleteProjects,
  findShareLinks,
  writeExport,
}: WorkspaceDialogsDependencies) {
  return setup({
    types: {
      context: declareType<WorkspaceDialogsContext>(),
      events: declareType<WorkspaceDialogsEvent>(),
    },
    actors: {
      renameProject: fromPromise<void, { project: ProjectRecord; name: string }>(({ input }) => renameProject(input)),
      deleteProjects: fromPromise<void, { projects: readonly ProjectRecord[] }>(({ input }) => deleteProjects(input)),
      findShareLinks: fromPromise<ReadonlyMap<string, ShareLinkRecord>, { projects: readonly ProjectRecord[] }>(
        ({ input }) => findShareLinks(input),
      ),
    },
    guards: {
      hasProjects: (_, projects: readonly ProjectRecord[]) => projects.length > 0,
      hasLinks: (_, links: ReadonlyMap<string, ShareLinkRecord>) => links.size > 0,
      isWaitingRelease: ({ context }, id: string) => context.releases.some((release) => release.project.id === id),
    },
    actions: {
      writeExport: (_, input: ProjectExport & { includeLinks: boolean }) => writeExport(input),
    },
  }).createMachine({
    id: "workspaceDialogs",
    type: "parallel",
    context: {
      projects: [],
      sharedCount: 0,
      name: "",
      error: "",
      export: undefined,
      includeLinks: false,
      releases: [],
      importOutcome: null,
    },
    states: {
      dialogs: {
        initial: "closed",
        on: {
          "create.open": { target: ".create", actions: assign({ error: "" }) },
          "rename.open": {
            target: ".rename",
            actions: assign({
              projects: ({ event }) => [event.project],
              name: ({ event }) => event.project.name,
              error: "",
            }),
          },
          "delete.open": {
            guard: { type: "hasProjects", params: ({ event }) => event.projects },
            target: ".delete",
            reenter: true,
            actions: assign({ projects: ({ event }) => event.projects, sharedCount: 0, error: "" }),
          },
          "export.start": {
            target: ".exportLookingUp",
            actions: assign({
              export: ({ event }) => ({ projects: event.projects, filename: event.filename, links: new Map() }),
              includeLinks: false,
            }),
          },
        },
        states: {
          closed: {},
          create: {
            on: {
              "dialog.close": "closed",
              "import.done": "closed",
            },
          },
          rename: {
            initial: "editing",
            on: { "dialog.close": "closed" },
            states: {
              editing: {
                on: {
                  "name.change": { actions: assign({ name: ({ event }) => event.name }) },
                  "dialog.submit": "saving",
                },
              },
              saving: {
                invoke: {
                  src: "renameProject",
                  input: ({ context }) => ({ project: getOnlyProject(context), name: context.name }),
                  onDone: "#workspaceDialogs.dialogs.closed",
                  onError: { target: "editing", actions: assign({ error: ({ event }) => getErrorText(event.error) }) },
                },
              },
            },
          },
          delete: {
            type: "parallel",
            on: { "dialog.close": "closed" },
            states: {
              question: {
                initial: "confirming",
                states: {
                  confirming: {
                    on: { "dialog.submit": "deleting" },
                  },
                  deleting: {
                    invoke: {
                      src: "deleteProjects",
                      input: ({ context }) => ({ projects: context.projects }),
                      onDone: "#workspaceDialogs.dialogs.closed",
                      onError: {
                        target: "confirming",
                        actions: assign({ error: ({ event }) => getErrorText(event.error) }),
                      },
                    },
                  },
                },
              },
              shareLinks: {
                initial: "lookingUp",
                states: {
                  lookingUp: {
                    invoke: {
                      src: "findShareLinks",
                      input: ({ context }) => ({ projects: context.projects }),
                      onDone: {
                        target: "known",
                        actions: assign({ sharedCount: ({ event }) => event.output.size }),
                      },
                      // A link that cannot be read only drops the sentence about shares; the delete still asks.
                      onError: "known",
                    },
                  },
                  known: {},
                },
              },
            },
          },
          exportLookingUp: {
            on: { "dialog.close": "closed" },
            invoke: {
              src: "findShareLinks",
              input: ({ context }) => ({ projects: getExport(context).projects }),
              onDone: [
                {
                  guard: { type: "hasLinks", params: ({ event }) => event.output },
                  target: "exportConfirm",
                  actions: assign({ export: ({ context, event }) => ({ ...getExport(context), links: event.output }) }),
                },
                {
                  target: "closed",
                  actions: {
                    type: "writeExport",
                    params: ({ context }) => ({ ...getExport(context), includeLinks: false }),
                  },
                },
              ],
              onError: {
                target: "closed",
                actions: {
                  type: "writeExport",
                  params: ({ context }) => ({ ...getExport(context), includeLinks: false }),
                },
              },
            },
          },
          exportConfirm: {
            on: {
              "links.toggle": { actions: assign({ includeLinks: ({ event }) => event.include }) },
              "dialog.submit": {
                target: "closed",
                actions: {
                  type: "writeExport",
                  params: ({ context }) => ({ ...getExport(context), includeLinks: context.includeLinks }),
                },
              },
              "dialog.close": "closed",
            },
          },
        },
      },
      releaseChooser: {
        initial: "waiting",
        on: {
          "import.done": {
            actions: assign({
              releases: ({ context, event }) => [
                ...context.releases,
                ...event.retired.map((project) => ({ kind: "import" as const, project })),
              ],
              importOutcome: ({ context, event }) =>
                addImportOutcome(countPendingImports(context.releases) > 0 ? context.importOutcome : null, event),
            }),
          },
          "import_report.dismiss": { actions: assign({ importOutcome: null }) },
        },
        states: {
          waiting: {
            on: {
              "releases.load": {
                target: "ready",
                actions: assign({
                  releases: ({ context, event }) => [
                    ...event.stored.map((project) => ({ kind: "stored" as const, project })),
                    ...context.releases,
                  ],
                }),
              },
            },
          },
          ready: {
            on: {
              "release.answer": {
                guard: { type: "isWaitingRelease", params: ({ event }) => event.id },
                actions: assign({
                  releases: ({ context, event }) =>
                    context.releases.filter((release) => release.project.id !== event.id),
                  importOutcome: ({ context, event }) =>
                    context.releases.some((release) => release.kind === "import" && release.project.id === event.id)
                      ? settleImportOutcome(context.importOutcome, event.answer)
                      : context.importOutcome,
                }),
              },
            },
          },
        },
      },
    },
  });
}

function countPendingImports(releases: readonly ReleaseChoice[]): number {
  return releases.filter((release) => release.kind === "import").length;
}

function addImportOutcome(
  shown: ImportOutcome | null,
  { added, skipped, releaseNotes }: Extract<WorkspaceDialogsEvent, { type: "import.done" }>,
): ImportOutcome {
  if (shown === null) {
    return { added, declined: 0, skipped, releaseNotes };
  }

  return {
    added: shown.added + added,
    declined: shown.declined,
    skipped: [...shown.skipped, ...skipped],
    releaseNotes: [...shown.releaseNotes, ...releaseNotes],
  };
}

// A banner dismissed while the chooser still asks stays dismissed.
function settleImportOutcome(shown: ImportOutcome | null, answer: ReleaseAnswer): ImportOutcome | null {
  if (shown === null) {
    return null;
  }

  return answer === "chosen" ? { ...shown, added: shown.added + 1 } : { ...shown, declined: shown.declined + 1 };
}

function getOnlyProject(context: WorkspaceDialogsContext): ProjectRecord {
  const [project] = context.projects;

  if (project === undefined) {
    throw new Error("Expected the rename dialog to hold a project, but got none.");
  }

  return project;
}

function getExport(context: WorkspaceDialogsContext): ProjectExport {
  if (context.export === undefined) {
    throw new Error("Expected an export while the export dialog is open, but got none.");
  }

  return context.export;
}

/** The workspace dialogs machine's snapshot. */
export type WorkspaceDialogsSnapshot = SnapshotFrom<ReturnType<typeof createWorkspaceDialogsMachine>>;

/**
 * The release the chooser asks about now
 *
 * Undefined while it waits for the workspace or has nothing to ask. Skips a stored project already in `projects`,
 * which another tab moved to a release first.
 */
export function getAskedRelease(
  snapshot: WorkspaceDialogsSnapshot,
  projects: readonly ProjectRecord[],
): ReleaseChoice | undefined {
  if (!snapshot.matches({ releaseChooser: "ready" })) {
    return undefined;
  }

  return snapshot.context.releases.find(
    (release) => release.kind === "import" || !projects.some((project) => project.id === release.project.id),
  );
}

/** The import banner's counts, or null when there is no banner. */
export function getImportReport(snapshot: WorkspaceDialogsSnapshot): ImportReport | null {
  const { importOutcome, releases } = snapshot.context;

  if (importOutcome === null) {
    return null;
  }

  return { ...importOutcome, pending: countPendingImports(releases) };
}
