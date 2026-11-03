import type { PendingEdit } from "@drizzle-run/runtime/machines";
import { createActor } from "xstate";
import * as z from "zod/mini";

import { CommunityTopicSchema, MAX_SHARE_DESCRIPTION_LENGTH, type CommunityTopic } from "../community/topics";
import { getHistorySetting, mergeStoredHistory, type ChatHistory } from "../connect/chat-history";
import { mergePendingEdits, PENDING_EDITS_SETTING } from "../connect/pending-edits";
import { TimestampSchema } from "../lib/api";
import {
  resolveRetiredPairProject,
  validateRecord,
  type ProjectRecord,
  type RetiredPairProject,
} from "../project/projects";
import { getStoreClient, type StoreClient } from "./client";
import type { CloudProjectRemoval, CloudRemovalPolicy, StoredProject } from "./service";
import {
  applyProjectReload,
  applyProjectWrite,
  createStoreQueueMachine,
  resolveBaseRevisions,
  type ProjectWrite,
  type StoreRevisions,
  type StoreTask,
  type StoreTaskOutcome,
} from "./store-queue-machine";

/** Where the workspace keeps its projects. */
export interface ProjectStorage {
  load(): Promise<ProjectRecord[]>;
  save(projects: readonly ProjectRecord[]): Promise<void>;
}

/** Reads one stored project without changing what the workspace's storage knows. */
export interface ProjectReader {
  /** The stored project, or null when there is none with that id or it cannot be opened. */
  readProject(projectId: string): Promise<ProjectRecord | null>;
}

/** Project storage that also keeps each project's open file. */
export interface ProjectPreferenceStorage extends ProjectStorage {
  preference(projectId: string, selectedFile?: string): Promise<string | undefined>;
}

/** App-wide settings, such as "the guide was seen", kept in the preferences store beside per-project choices. */
export interface SettingStore {
  readSetting(key: string): Promise<unknown>;
  writeSetting(key: string, value: unknown): Promise<void>;
}

/** The settings store, with the merges the AI chat writes: each one reads and writes in one store transaction. */
export interface ConnectSettingStore extends SettingStore {
  /** Saves a tab's chat history over the stored one, keeping rows and answers another tab saved. */
  mergeChatHistory(conversation: string, history: ChatHistory): Promise<void>;
  /** Saves a tab's pending edits beside another tab's, dropping the ones this tab settled (`knownIds`). */
  mergePendingEdits(edits: readonly PendingEdit[], knownIds: readonly string[]): Promise<void>;
}

/** What this browser needs to push changes to a project's shared link. */
export interface ShareLinkRecord {
  linkId: string;
  /** When this browser last published or pushed to the link, or checked what it shows. */
  publishedAt: string;
  /** The link's description, which the next push starts with. Absent when it has none. */
  description?: string;
  /**
   * The content digest of what the link shows, which tells the editor whether the project changed since.
   * Absent until this browser publishes or checks the link, such as for a fork or an import.
   */
  publishedDigest?: string;
  /** Set while this browser keeps the link listed in Community. */
  listing?: ShareLinkListing;
}

/** A share link this browser holds, and the project it shares. */
export interface ProjectShareLink {
  projectId: string;
  link: ShareLinkRecord;
}

/** A link's Community listing: its topic, and the description its card shows. */
export interface ShareLinkListing {
  topic: CommunityTopic;
  /** Absent when the card shows no description. */
  description?: string;
}

/** The share links this browser made, by project. */
export interface ShareLinkStore {
  shareLink(projectId: string): Promise<ShareLinkRecord | undefined>;
  saveShareLink(projectId: string, link: ShareLinkRecord): Promise<void>;
  /** Forgets the project's share link while it is still `linkId`; a different link saved since stays. */
  deleteShareLink(projectId: string, linkId: string): Promise<void>;
}

/** This browser's cloud sync state for one project. */
export interface CloudSyncState {
  projectId: string;
  /** The cloud revision this browser last matched; 0 before the first save. */
  revision: number;
  /** The content digest at that revision; empty before the first save. */
  digest: string;
}

/** The cloud sync state this browser keeps, by GitHub account (its numeric id) and project. */
export interface CloudSyncStore {
  loadCloudSync(githubId: number): Promise<CloudSyncState[]>;
  writeCloudSync(githubId: number, state: CloudSyncState): Promise<void>;
  deleteCloudSync(githubId: number, projectId: string): Promise<void>;
}

const StoredRecordIdSchema = z.object({ id: z.string().check(z.minLength(1)) });

const ShareDescriptionSchema = z.string().check(z.minLength(1), z.maxLength(MAX_SHARE_DESCRIPTION_LENGTH));

const ShareLinkListingSchema = z.object({
  topic: CommunityTopicSchema,
  description: z.catch(z.optional(ShareDescriptionSchema), undefined),
});

const ShareLinkRecordSchema = z.object({
  linkId: z.string().check(z.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)),
  publishedAt: TimestampSchema,
  description: z.catch(z.optional(ShareDescriptionSchema), undefined),
  publishedDigest: z.catch(z.optional(z.string().check(z.regex(/^[0-9a-f]{64}$/))), undefined),
  listing: z.catch(z.optional(ShareLinkListingSchema), undefined),
});

/** A share link record, or undefined when the value is not a well-formed one (an old or edited export). */
export function readShareLinkRecord(value: unknown): ShareLinkRecord | undefined {
  const parsed = ShareLinkRecordSchema.safeParse(value);

  if (!parsed.success) {
    return undefined;
  }

  const { description, publishedDigest, listing, ...link } = parsed.data;

  return {
    ...link,
    ...(description === undefined ? {} : { description }),
    ...(publishedDigest === undefined ? {} : { publishedDigest }),
    ...(listing === undefined ? {} : { listing: toShareLinkListing(listing) }),
  };
}

function toShareLinkListing({ description, ...listing }: z.output<typeof ShareLinkListingSchema>): ShareLinkListing {
  return description === undefined ? listing : { ...listing, description };
}

/** Storage in memory, for temporary copies such as an example or a guide. */
export class VolatileProjectStorage
  implements ProjectPreferenceStorage, ProjectReader, ConnectSettingStore, ShareLinkStore
{
  #preferences = new Map<string, string>();
  #settings = new Map<string, unknown>();
  #shareLinks = new Map<string, ShareLinkRecord>();

  async load(): Promise<ProjectRecord[]> {
    return [];
  }

  async save(_projects: readonly ProjectRecord[]): Promise<void> {}

  async readProject(_projectId: string): Promise<ProjectRecord | null> {
    return null;
  }

  async preference(projectId: string, selectedFile?: string): Promise<string | undefined> {
    if (selectedFile !== undefined) {
      this.#preferences.set(projectId, selectedFile);
    }

    return this.#preferences.get(projectId);
  }

  async readSetting(key: string): Promise<unknown> {
    return structuredClone(this.#settings.get(key));
  }

  async writeSetting(key: string, value: unknown): Promise<void> {
    this.#settings.set(key, structuredClone(value));
  }

  async mergeChatHistory(conversation: string, history: ChatHistory): Promise<void> {
    const key = getHistorySetting(conversation);
    this.#settings.set(key, mergeStoredHistory(this.#settings.get(key), structuredClone(history), conversation));
  }

  async mergePendingEdits(edits: readonly PendingEdit[], knownIds: readonly string[]): Promise<void> {
    const merged = mergePendingEdits(this.#settings.get(PENDING_EDITS_SETTING), structuredClone(edits), knownIds);
    this.#settings.set(PENDING_EDITS_SETTING, merged);
  }

  async shareLink(projectId: string): Promise<ShareLinkRecord | undefined> {
    return structuredClone(this.#shareLinks.get(projectId));
  }

  async saveShareLink(projectId: string, link: ShareLinkRecord): Promise<void> {
    this.#shareLinks.set(projectId, structuredClone(link));
  }

  async deleteShareLink(projectId: string, linkId: string): Promise<void> {
    if (this.#shareLinks.get(projectId)?.linkId === linkId) {
      this.#shareLinks.delete(projectId);
    }
  }
}

/** Projects another tab wrote or deleted, or ones this tab's save found newer in the store. */
export interface ExternalProjectChange {
  /** The store's copy of each written project this storage can read. */
  projects: ProjectRecord[];
  deletedIds: string[];
  /**
   * The revision this tab last knew the store held for each written or deleted project, before this change.
   * A copy here at another revision holds edits the store never took. Absent for a project this tab never saved or loaded.
   */
  knownRevisions: Record<string, number>;
}

const ProjectChangeMessageSchema = z.object({
  ids: z.array(z.string()),
  deletedIds: z.array(z.string()),
});

/** A task's work: the revisions it learned, its result, and what to tell listeners once the revisions are in place. */
type RunStoreTask<Result> = (
  revisions: StoreRevisions,
) => Promise<{ revisions: StoreRevisions; result: Result; notify?: () => void }>;

function toStoreTask<Result>(
  type: StoreTask["type"],
  run: RunStoreTask<Result>,
  caller: { resolve: (result: Result) => void; reject: (cause: unknown) => void },
): StoreTask {
  return {
    type,
    run: async (revisions): Promise<StoreTaskOutcome> => {
      const { revisions: nextRevisions, result, notify } = await run(revisions);

      return {
        revisions: nextRevisions,
        settle: () => {
          notify?.();
          caller.resolve(result);
        },
      };
    },
    fail: caller.reject,
  };
}

/** Where a local storage keeps its data. Without a client, it uses this tab's store worker for `storeName`. */
export interface LocalProjectStorageOptions {
  storeName?: string;
  client?: StoreClient;
}

/**
 * Storage in this browser's local store, an SQLite database the store worker keeps (see store/schema.ts).
 * Writes run one at a time, and records it cannot read are kept for recovery or export.
 */
export class LocalProjectStorage
  implements ProjectPreferenceStorage, ProjectReader, ConnectSettingStore, ShareLinkStore, CloudSyncStore
{
  #queue = createActor(createStoreQueueMachine()).start();
  #changeListeners = new Set<(change: ExternalProjectChange) => void>();
  #channel: BroadcastChannel | undefined;
  #recoverableCount = 0;
  #recoverableRecords: unknown[] = [];
  #retiredPairProjects: RetiredPairProject[] = [];
  #client: StoreClient | undefined;
  readonly storeName: string;

  constructor({ storeName = "drizzle-run", client }: LocalProjectStorageOptions = {}) {
    this.storeName = storeName;
    this.#client = client;
  }

  get recoverableCount(): number {
    return this.#recoverableCount;
  }

  getRecoverableRecords(): readonly unknown[] {
    return structuredClone(this.#recoverableRecords);
  }

  /** Projects whose ORM/Kit pair left the catalog; their records stay untouched until a new pair is chosen. */
  getRetiredPairProjects(): readonly RetiredPairProject[] {
    return structuredClone(this.#retiredPairProjects);
  }

  /** Ids of the stored projects the workspace cannot open: on a removed pair, or kept for recovery. */
  listUnopenableProjectIds(): string[] {
    const recoverableIds = this.#recoverableRecords.flatMap((record) => {
      const stored = StoredRecordIdSchema.safeParse(record);

      return stored.success ? [stored.data.id] : [];
    });

    return [...this.#retiredPairProjects.map((retired) => retired.id), ...recoverableIds];
  }

  get #store(): StoreClient {
    if (this.#client === undefined || this.#client.failure !== undefined) {
      this.#client = getStoreClient(this.storeName);
    }

    return this.#client;
  }

  /**
   * Load the workspace's projects
   *
   * Runs in turn with saves and other tabs' changes, and sets what later saves write and delete, so only the
   * workspace that owns this storage calls it. Other reads use `readProject`.
   */
  load(): Promise<ProjectRecord[]> {
    return this.#enqueue("load", async (revisions) => {
      const projects = await this.#loadProjects();

      return {
        revisions: {
          known: new Map(projects.map((project) => [project.id, project.revision])),
          reloads: revisions.reloads,
        },
        result: projects,
      };
    });
  }

  async readProject(projectId: string): Promise<ProjectRecord | null> {
    const record = await this.#store.call("readProject", projectId);

    if (record === undefined) {
      return null;
    }

    try {
      return validateRecord(record);
    } catch {
      return null;
    }
  }

  async #loadProjects(): Promise<ProjectRecord[]> {
    const records = await this.#store.call("loadProjects");
    const projects: ProjectRecord[] = [];
    this.#recoverableRecords = [];
    this.#recoverableCount = 0;
    this.#retiredPairProjects = [];

    for (const record of records) {
      try {
        projects.push(validateRecord(record));
      } catch {
        this.#setAside(record);
      }
    }

    return projects;
  }

  /** Keep a stored record this tab cannot open: asked about when on a removed pair, kept for recovery otherwise. */
  #setAside(record: StoredProject) {
    const retired = resolveRetiredPairProject(record);

    if (retired) {
      this.#retiredPairProjects = [
        ...this.#retiredPairProjects.filter((known) => known.id !== retired.id),
        structuredClone(retired),
      ];

      return;
    }

    this.#recoverableRecords = [
      ...this.#recoverableRecords.filter((known) => StoredRecordIdSchema.safeParse(known).data?.id !== record.id),
      structuredClone(record),
    ];
    this.#recoverableCount = this.#recoverableRecords.length;
  }

  #forgetSetAside(ids: ReadonlySet<string>) {
    this.#retiredPairProjects = this.#retiredPairProjects.filter((retired) => !ids.has(retired.id));
    this.#recoverableRecords = this.#recoverableRecords.filter(
      (record) => !ids.has(StoredRecordIdSchema.safeParse(record).data?.id ?? ""),
    );
    this.#recoverableCount = this.#recoverableRecords.length;
  }

  /**
   * Listen for projects changed outside this workspace
   *
   * Calls `listener` with the store's copy of projects another tab of this browser saved or deleted, and of projects a
   * save here found newer in the store. Returns the function that stops listening.
   */
  onExternalChange(listener: (change: ExternalProjectChange) => void): () => void {
    this.#changeListeners.add(listener);
    this.#openChannel();

    return () => {
      this.#changeListeners.delete(listener);

      if (this.#changeListeners.size === 0) {
        this.#channel?.close();
        this.#channel = undefined;
      }
    };
  }

  /**
   * Save the workspace's projects
   *
   * Writes the projects that are new or changed since this storage last knew them, and deletes the ones it knew that
   * are no longer in the list, with their share links. Rows it never knew (another tab's, or ones kept for recovery)
   * stay. A project another tab saved at a newer revision keeps that copy, which comes back through
   * `onExternalChange`. Saves run one at a time: on an idle queue the request reaches the store worker before this
   * returns, but a save asked for while another read or write runs is sent only once that one settles, so a tab closed
   * in between loses it.
   */
  save(projects: readonly ProjectRecord[]): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();

    this.#queue.send({
      type: "write.queued",
      projects,
      createTask: (write) =>
        toStoreTask("write", (revisions) => this.#writeProjects(write, revisions), { resolve, reject }),
    });

    return promise;
  }

  #enqueue<Result>(type: StoreTask["type"], run: RunStoreTask<Result>): Promise<Result> {
    const { promise, resolve, reject } = Promise.withResolvers<Result>();

    this.#queue.send({ type: "task.queued", task: toStoreTask(type, run, { resolve, reject }) });

    return promise;
  }

  async #writeProjects(write: ProjectWrite, revisions: StoreRevisions) {
    if (write.changed.length === 0 && write.deletedIds.length === 0) {
      return { revisions, result: undefined };
    }

    const baseRevisions = resolveBaseRevisions(write, revisions);
    const { stale } = await this.#store.call("saveProjects", write.changed, write.deletedIds, baseRevisions);
    const staleIds = new Set(stale);
    const writtenIds = write.changed.map((project) => project.id).filter((id) => !staleIds.has(id));
    const written = applyProjectWrite(write, staleIds, revisions);

    // A set-aside project this tab just wrote, such as one moved to a new release, opens now.
    this.#forgetSetAside(new Set(writtenIds));

    if (writtenIds.length > 0 || write.deletedIds.length > 0) {
      this.#announce({ ids: writtenIds, deletedIds: [...write.deletedIds] });
    }

    if (stale.length > 0) {
      return this.#reloadProjects(stale, [], written);
    }

    return { revisions: written, result: undefined };
  }

  // A storage that does not listen, such as a shared link's fork, opens a channel just to tell the other tabs.
  #announce(change: { ids: string[]; deletedIds: string[] }) {
    if (this.#channel !== undefined) {
      this.#channel.postMessage(change);

      return;
    }

    if (typeof BroadcastChannel === "undefined") {
      return;
    }

    const channel = new BroadcastChannel(`drizzle-run-store:${this.storeName}`);
    channel.postMessage(change);
    channel.close();
  }

  #openChannel() {
    if (this.#channel !== undefined || typeof BroadcastChannel === "undefined") {
      return;
    }

    this.#channel = new BroadcastChannel(`drizzle-run-store:${this.storeName}`);
    this.#channel.addEventListener("message", (event: MessageEvent<unknown>) => {
      const message = ProjectChangeMessageSchema.safeParse(event.data);

      if (!message.success) {
        return;
      }

      void this.#enqueue("reload", (revisions) =>
        this.#reloadProjects(message.data.ids, message.data.deletedIds, revisions),
      ).catch((cause: unknown) => console.error("Could not read the projects another tab saved", cause));
    });
  }

  // Reads `ids` from the store; the listeners hear once the revisions are in place, so a save they start sees them.
  async #reloadProjects(ids: readonly string[], heardDeletedIds: readonly string[], revisions: StoreRevisions) {
    const wanted = new Set(ids);
    const records = await this.#store.call("loadProjects");
    const storedIds = new Set(records.map((record) => record.id));
    // A project this tab knew that is gone from the store was deleted by another tab, even if this tab has not heard.
    const deletedIds = [
      ...new Set([...heardDeletedIds, ...ids.filter((id) => !storedIds.has(id) && revisions.known.has(id))]),
    ];
    const projects: ProjectRecord[] = [];

    for (const record of records) {
      if (!wanted.has(record.id)) {
        continue;
      }

      try {
        projects.push(validateRecord(record));
      } catch {
        this.#setAside(record);
      }
    }

    const knownRevisions: Record<string, number> = {};

    for (const id of [...projects.map((project) => project.id), ...deletedIds]) {
      const knownRevision = revisions.known.get(id);

      if (knownRevision !== undefined) {
        knownRevisions[id] = knownRevision;
      }
    }

    // A set-aside project another tab moved, rewrote readably or deleted is no longer offered here: a stale chooser
    // would write it back, and a stale recovery record would keep it from syncing.
    const settledIds = new Set([
      ...projects.map((project) => project.id),
      ...heardDeletedIds,
      ...ids.filter((id) => !storedIds.has(id)),
    ]);
    this.#forgetSetAside(settledIds);

    const change: ExternalProjectChange = { projects, deletedIds: [...deletedIds], knownRevisions };

    return {
      revisions: applyProjectReload(projects, deletedIds, revisions),
      result: undefined,
      notify: () => {
        for (const listener of this.#changeListeners) {
          listener(structuredClone(change));
        }
      },
    };
  }

  async preference(projectId: string, selectedFile?: string): Promise<string | undefined> {
    if (selectedFile === undefined) {
      return this.#store.call("readPreference", projectId);
    }

    await this.#store.call("writePreference", projectId, selectedFile);

    return selectedFile;
  }

  async readSetting(key: string): Promise<unknown> {
    return this.#store.call("readSetting", key);
  }

  async writeSetting(key: string, value: unknown): Promise<void> {
    await this.#store.call("writeSetting", key, value);
  }

  async mergeChatHistory(conversation: string, history: ChatHistory): Promise<void> {
    await this.#store.call("mergeChatHistory", conversation, history);
  }

  async mergePendingEdits(edits: readonly PendingEdit[], knownIds: readonly string[]): Promise<void> {
    await this.#store.call("mergePendingEdits", edits, knownIds);
  }

  async shareLink(projectId: string): Promise<ShareLinkRecord | undefined> {
    return readShareLinkRecord(await this.#store.call("readShareLink", projectId));
  }

  /** The readable share links this browser holds, by project, independent of cloud sync and project loading. */
  async listShareLinks(): Promise<ProjectShareLink[]> {
    const records = await this.#store.call("readShareLinks");

    return records.flatMap(({ projectId, link: value }) => {
      const link = readShareLinkRecord(value);

      return link === undefined ? [] : [{ projectId, link }];
    });
  }

  async saveShareLink(projectId: string, link: ShareLinkRecord): Promise<void> {
    await this.#store.call("writeShareLink", projectId, structuredClone(link));
  }

  async deleteShareLink(projectId: string, linkId: string): Promise<void> {
    await this.#store.call("deleteShareLink", projectId, linkId);
  }

  async loadCloudSync(githubId: number): Promise<CloudSyncState[]> {
    return this.#store.call("loadCloudSync", githubId);
  }

  async writeCloudSync(githubId: number, state: CloudSyncState): Promise<void> {
    await this.#store.call("writeCloudSync", githubId, { ...state });
  }

  async deleteCloudSync(githubId: number, projectId: string): Promise<void> {
    await this.#store.call("deleteCloudSync", githubId, projectId);
  }

  /**
   * End an account's local Cloud state using the requested unsaved-edit policy
   *
   * Their share links stay, so a project that comes back on sign-in is still tied to its link. Removed projects are
   * announced to this workspace and other tabs; retained unsaved projects lose their Cloud rows and become Local.
   */
  removeCloudProjects(githubId: number | null, policy: CloudRemovalPolicy): Promise<CloudProjectRemoval> {
    return this.#enqueue("write", async (revisions) => {
      const result = await this.#store.call("removeCloudProjects", githubId, policy);
      this.#announce({ ids: [], deletedIds: result.removedIds });
      const reloaded = await this.#reloadProjects([], result.removedIds, revisions);

      return { ...reloaded, result };
    });
  }
}
