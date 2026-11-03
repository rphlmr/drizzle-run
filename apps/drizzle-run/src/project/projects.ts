import {
  DIALECTS,
  getRecommendedTuple,
  hasGuestFlavor,
  listSupportedTuples,
  resolveGuestFlavor,
  resolveSupportedTuple,
  type Dialect,
  type GuestFlavor,
  type RuntimeTupleId,
  type RuntimeTupleSelection,
  type SupportedRuntimeTuple,
} from "@drizzle-run/core/catalog";
import type { ProjectOrigin } from "@drizzle-run/core/connect";
import {
  ProjectSourceSchema,
  type PlaygroundSnapshot,
  type ProjectSource,
  type RetiredPairSnapshot,
} from "@drizzle-run/core/contracts";
import {
  assertImportsAvailable,
  findRetiredPair,
  followInPlaceRelease,
  inPlaceSuccessor,
  moveManifestToPair,
  parseRunManifest,
  PROJECT_FILE_EXTENSIONS,
  type RetiredPair,
  type RunManifest,
  type RunManifestTarget,
} from "@drizzle-run/core/manifest";
import {
  addPairFile,
  changePairSide,
  createPairManifest,
  editPairFile,
  findRetiredPairSides,
  followPairInPlaceRelease,
  isPairManifestLike,
  isSharedPairFile,
  listManifestDialects,
  listManifestTargets,
  moveRetiredPairSides,
  PAIR_SEED_PATH,
  pairSideTuple,
  parsePairManifest,
  renamePairSide,
  sharePairFile,
  splitPairFile,
  swapPairSides,
  type PairFilesStart,
  type PairManifest,
  type PairSideFiles,
  type PairSideIndex,
} from "@drizzle-run/core/pair";
import * as z from "zod/mini";

import { TimestampSchema } from "../lib/api";
import { IntegerSchema } from "../lib/records";
import { createLocalId } from "./local-id";

/**
 * A stored project. Its manifest says its kind: a run manifest runs on one Drizzle
 * release, a pair manifest side by side on two. Both kinds share one record version.
 */
export interface ProjectRecordOf<Manifest extends RunManifest | PairManifest> {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  manifest: Manifest;
  /** `community`: opened or forked from someone else's share, so its files are the author's. */
  origin?: ProjectOrigin;
  /** The official example or guide version it was forked from, which its docs are read from. */
  source?: ProjectSource;
  /**
   * Whether the user lets the AI change and run it. Someone else's project starts `untrusted`, and only the user's own
   * act (Allow AI edits) moves it; their own projects are `trusted` from birth.
   */
  trust: ProjectTrust;
}

/** Whether the user lets the AI change and run a project. */
export type ProjectTrust = "trusted" | "untrusted";

/** The user's own act on a project's trust, from the chat note or the project menu. Nothing the AI sends is one. */
export type ProjectTrustEvent = { type: "project.trust" } | { type: "project.untrust" };

/** A project that runs on one release. */
export type OneVersionProject = ProjectRecordOf<RunManifest>;
/** A project that runs on two sides, each on its own release and database. */
export type SideBySideProject = ProjectRecordOf<PairManifest>;
/** A stored project of either kind. */
export type ProjectRecord = OneVersionProject | SideBySideProject;

/** Whether the manifest runs two sides. */
export function isPairManifest(manifest: RunManifest | PairManifest): manifest is PairManifest {
  return manifest.kind === "drizzle-run-pair";
}

/** Whether the project runs two sides. */
export function isSideBySide(project: ProjectRecord): project is SideBySideProject {
  return isPairManifest(project.manifest);
}

/** Whether the project runs on one release. */
export function isOneVersion(project: ProjectRecord): project is OneVersionProject {
  return !isPairManifest(project.manifest);
}

/** The record's own fields with a manifest of either kind, as the kind its manifest says. */
function withManifest(fields: Omit<ProjectRecord, "manifest">, manifest: RunManifest | PairManifest): ProjectRecord {
  return isPairManifest(manifest) ? { ...fields, manifest } : { ...fields, manifest };
}

/**
 * Tab order: run entrypoint, schema, seed (when present), then the rest
 * alphabetically. A disabled seed keeps its slot, so toggling seed execution
 * does not move its tab; `seedPath` names it while it is not an entrypoint.
 */
export function orderProjectFiles(manifest: RunManifest, seedPath = "seed.ts"): string[] {
  const { run, schema } = manifest.entrypoints;
  const seed = manifest.entrypoints.seed ?? seedPath;
  const entries = [run, schema, seed].filter(
    (path, index, list): path is string => path !== undefined && path in manifest.files && list.indexOf(path) === index,
  );
  const helpers = Object.keys(manifest.files)
    .filter((path) => !entries.includes(path))
    .toSorted((left, right) => left.localeCompare(right));

  return [...entries, ...helpers];
}

/**
 * The catalog target of a manifest's side: its database
 *
 * A one-version manifest has one side, 0. A side-by-side manifest runs a database per side, so the side is required.
 */
export function getCatalogTarget(manifest: RunManifest, side?: 0): RunManifestTarget;

export function getCatalogTarget(manifest: RunManifest | PairManifest, side: PairSideIndex): RunManifestTarget;

export function getCatalogTarget(manifest: RunManifest | PairManifest, side: PairSideIndex = 0): RunManifestTarget {
  const target = listManifestTargets(manifest)[side];

  if (target === undefined) {
    throw new Error(`Expected side 0 of a one-version project, but got side ${side}`);
  }

  return { dialect: target.dialect };
}

/** The databases a project runs, by label: "PostgreSQL", or "PostgreSQL vs SQLite" for sides on two databases. */
export function formatProjectDialects(manifest: RunManifest | PairManifest): string {
  return listProjectDialects(manifest)
    .map((dialect) => DIALECTS[dialect].label)
    .join(" vs ");
}

/** The databases a project runs, in side order and without repeats. */
export function listProjectDialects(manifest: RunManifest | PairManifest): RunManifestTarget["dialect"][] {
  return listManifestDialects(manifest);
}

const fileExtensionList = new Intl.ListFormat("en", { type: "disjunction" });

/** Returns the path when it is a safe project file path; throws otherwise. */
export function validateFilePath(path: string): string {
  const name = path.split("/").at(-1) ?? "";

  if (path.startsWith("./")) {
    throw new Error(`Write the path without "./", such as "${path.slice(2)}".`);
  }

  if (
    !/^(?:[\w-]+\/)*[\w.-]+$/.test(path) ||
    !PROJECT_FILE_EXTENSIONS.some((extension) => name.endsWith(extension) && name.length > extension.length) ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error(`Use a relative ${fileExtensionList.format(PROJECT_FILE_EXTENSIONS)} path.`);
  }

  return path;
}

/** Parses a manifest; one on an older Legacy version follows the Legacy pair, which fix releases update in place. */
export function validateManifest(value: unknown): RunManifest {
  const manifest = parseRunManifest(followInPlaceRelease(value));

  for (const path of Object.keys(manifest.files)) {
    validateFilePath(path);
  }

  return manifest;
}

/** Parses a side-by-side manifest and checks every file path; a side on an older Legacy version follows the Legacy pair. */
export function validatePairManifest(value: unknown): PairManifest {
  const manifest = parsePairManifest(followPairInPlaceRelease(value));

  for (const path of [...Object.keys(manifest.files), ...Object.keys(manifest.sides[0].files)]) {
    validateFilePath(path);
  }

  return manifest;
}

/** Parses either kind of manifest, by its `kind`. */
export function validateProjectManifest(value: unknown): RunManifest | PairManifest {
  return isPairManifestLike(value) ? validatePairManifest(value) : validateManifest(value);
}

/**
 * The starter query on the Effect guest: the Effect query API on the playground's database, through its own connection
 * (`postgresConnection`) on PostgreSQL and the playground's client (`db.$client`) on SQLite.
 */
const EFFECT_STARTER_QUERY = {
  postgresql: `import * as Effect from "effect/Effect";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { postgresConnection } from "@drizzle-run/runtime/context";
import { users } from "./schema";

// Effect's client opens its own connection to the playground's database, so its queries show up in SQL like any other.
const client = PgClient.layerFrom(PgClient.makeClient(postgresConnection));

const program = Effect.gen(function* () {
  // paramsInErrors keeps a failed query's params in its error message.
  const effectDb = yield* PgDrizzle.makeWithDefaults({ paramsInErrors: true });
  return yield* effectDb.select().from(users);
});

const rows = await Effect.runPromise(program.pipe(Effect.provide(client)));
console.log("Found", rows.length, "users");
$.display("Users", rows);
`,
  sqlite: `import * as Effect from "effect/Effect";
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient";
import * as LibsqlDrizzle from "drizzle-orm/effect-libsql";
import { db } from "@drizzle-run/runtime/context";
import { users } from "./schema";

// Effect queries run on the playground's database client, so they show up in SQL like any other.
const client = LibsqlClient.layer({ liveClient: db.$client });

const program = Effect.gen(function* () {
  // paramsInErrors keeps a failed query's params in its error message.
  const effectDb = yield* LibsqlDrizzle.makeWithDefaults({ paramsInErrors: true });
  return yield* effectDb.select().from(users);
});

const rows = await Effect.runPromise(program.pipe(Effect.provide(client)));
console.log("Found", rows.length, "users");
$.display("Users", rows);
`,
} as const;

function getStarterFiles(dialect: Dialect, guestFlavor: GuestFlavor): Record<string, string> {
  return {
    "schema.ts": DIALECTS[dialect].starterSchema,
    "seed.ts":
      'import { db } from "@drizzle-run/runtime/context";\nimport { users } from "./schema";\n\nawait db.insert(users).values([\n  { id: 1, name: "Ada" },\n  { id: 2, name: "Grace" },\n]);\n',
    "query.ts":
      guestFlavor === "effect"
        ? EFFECT_STARTER_QUERY[dialect]
        : 'import { db } from "@drizzle-run/runtime/context";\nimport { users } from "./schema";\n\nconst rows = await db.select().from(users);\nconsole.log("Found", rows.length, "users");\n$.display("Users", rows);\n',
  };
}

/** The tested pair with this id, on whichever database it runs; throws for a pair the catalog does not ship. */
function getTuple(tupleId: RuntimeTupleId): SupportedRuntimeTuple {
  const tuple = listSupportedTuples().find((item) => item.id === tupleId);

  if (!tuple) {
    throw new Error("Choose a Drizzle release the catalog runs.");
  }

  return tuple;
}

function getTupleForTarget(target: RunManifestTarget, tupleId: RuntimeTupleId | undefined) {
  if (tupleId === undefined) {
    return getRecommendedTuple(target);
  }

  const tuple = listSupportedTuples(target).find((item) => item.id === tupleId);

  if (!tuple) {
    throw new Error("Choose a Drizzle release that supports this database.");
  }

  return tuple;
}

function createStarterManifest(
  target: RunManifestTarget,
  tuple: SupportedRuntimeTuple,
  guestFlavor: GuestFlavor = "slim",
): RunManifest {
  return validateManifest({
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: target.dialect },
    dependencies: { "drizzle-orm": tuple.ormVersion, "drizzle-kit": tuple.kitVersion },
    guestFlavor,
    entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "query.ts" },
    files: getStarterFiles(target.dialect, guestFlavor),
  });
}

/** A new one-version project from the starter files, on the chosen pair and flavor or the recommended plain pair. */
export function createProject(
  name: string,
  target: RunManifestTarget,
  tupleId?: RuntimeTupleId,
  guestFlavor: GuestFlavor = "slim",
): OneVersionProject {
  return createRecord(name, createStarterManifest(target, getTupleForTarget(target, tupleId), guestFlavor));
}

/** Names both sides, in side order; an empty name leaves a side to go by its release. */
function nameSides(manifest: PairManifest, names: readonly [string, string]): PairManifest {
  return renamePairSide(renamePairSide(manifest, 0, names[0]), 1, names[1]);
}

/**
 * A new side-by-side project on two pairs, its files separate per side (the seed stays shared) or shared
 *
 * `targets` picks each side's database, and each side starts from its database's starter. Sides on two databases
 * share every file but the schema, which each side keeps for its own database. `guestFlavors` picks each side's
 * flavor; both run plain without it. Both sides may be on one pair. `names` names the sides, in order; an empty name
 * goes by the release.
 */
export function createSideBySideProject(
  name: string,
  targets: readonly [RunManifestTarget, RunManifestTarget],
  tupleIds: readonly [RuntimeTupleId, RuntimeTupleId],
  files: PairFilesStart,
  guestFlavors: readonly [GuestFlavor, GuestFlavor] = ["slim", "slim"],
  names: readonly [string, string] = ["", ""],
): SideBySideProject {
  const tuples = [getTupleForTarget(targets[0], tupleIds[0]), getTupleForTarget(targets[1], tupleIds[1])] as const;
  const bases = [createStarterManifest(targets[0], tuples[0]), createStarterManifest(targets[1], tuples[1])] as const;
  const manifest = createPairManifest(bases, tuples, files, guestFlavors);

  return createRecord(name, validatePairManifest(nameSides(manifest, names)));
}

/**
 * Forks a one-version project as side by side: the project's own pair and flavor are one side, `tupleId` in
 * `guestFlavor` the other, which may be the same pair or a pair on the other database. Both sides start from the
 * project's files: a side on the other database keeps the project's schema as written, so its editor reports what to
 * rewrite. `first` names which shows first, and `names` names the sides in display order. The project itself stays as
 * it is.
 */
export function forkAsSideBySide(
  project: OneVersionProject,
  name: string,
  tupleId: RuntimeTupleId,
  files: PairFilesStart,
  first: "project" | "new" = "project",
  guestFlavor: GuestFlavor = "slim",
  names: readonly [string, string] = ["", ""],
): SideBySideProject {
  const target = getCatalogTarget(project.manifest);
  const current = resolveSupportedTuple({
    target,
    ormVersion: project.manifest.dependencies["drizzle-orm"],
    kitVersion: project.manifest.dependencies["drizzle-kit"],
  });
  const other = getTuple(tupleId);
  const currentFlavor = resolveGuestFlavor(project.manifest);
  const tuples = first === "project" ? ([current, other] as const) : ([other, current] as const);
  const guestFlavors =
    first === "project" ? ([currentFlavor, guestFlavor] as const) : ([guestFlavor, currentFlavor] as const);

  const manifest = createPairManifest(structuredClone(project.manifest), tuples, files, guestFlavors);

  return withOriginOf(createRecord(name, validatePairManifest(nameSides(manifest, names))), project);
}

/** A new project from a manifest, of the kind the manifest is; throws when the manifest is invalid. */
export function createProjectFromManifest(name: string, manifest: RunManifest): OneVersionProject;

export function createProjectFromManifest(name: string, manifest: PairManifest): SideBySideProject;

export function createProjectFromManifest(name: string, manifest: RunManifest | PairManifest): ProjectRecord;

export function createProjectFromManifest(name: string, manifest: RunManifest | PairManifest): ProjectRecord {
  const record = createRecord(name, validateProjectManifest(manifest));

  return withManifest(record, record.manifest);
}

/**
 * Mark a project as someone else's
 *
 * For a shared link, a Community share, and every fork or copy of one: agents read its content as data, and an agent
 * run of it waits for the user.
 */
export function toCommunityProject<Project extends ProjectRecord>(project: Project): Project {
  return { ...project, origin: "community", trust: "untrusted" };
}

/** Record the official example or guide version a project was forked from. */
export function withSource<Project extends ProjectRecord>(project: Project, source: ProjectSource): Project {
  return { ...project, source };
}

/**
 * Keep a project's origin, trust and official source on a project made from it
 *
 * A copy never gains trust, and keeps the docs of the version its project was forked from.
 */
function withOriginOf<Project extends ProjectRecord>(project: Project, from: ProjectRecord): Project {
  const marked =
    from.origin === "community" ? { ...project, origin: "community" as const, trust: from.trust } : project;

  return from.source === undefined ? marked : withSource(marked, from.source);
}

/**
 * Apply the user's trust act
 *
 * `trusted` ⇄ `untrusted`, on someone else's project only: the user's own projects stay trusted. Returns the same
 * project when the event changes nothing, so callers save only a real change.
 */
export function transitionProjectTrust<Project extends ProjectRecord>(
  project: Project,
  event: ProjectTrustEvent,
): Project {
  const next: ProjectTrust = event.type === "project.trust" ? "trusted" : "untrusted";

  if (project.origin !== "community" || project.trust === next) {
    return project;
  }

  return { ...project, trust: next, revision: project.revision + 1, updatedAt: new Date().toISOString() };
}

/** The AI tools a project view offers: someone else's project reads only until the user trusts it. */
export function getProjectScope(project: ProjectRecord): "project" | "untrusted" {
  return project.trust === "trusted" ? "project" : "untrusted";
}

/**
 * A copy of the project, named `name` or "<name> copy"; a side-by-side project's copy stays side by side. Its origin
 * and source stay too.
 */
export function duplicateProject<Project extends ProjectRecord>(project: Project, name?: string): Project;

export function duplicateProject(project: ProjectRecord, name = `${project.name.slice(0, 150)} copy`): ProjectRecord {
  const record = createRecord(name, structuredClone(project.manifest));

  return withOriginOf(withManifest(record, record.manifest), project);
}

/** Throws when a project name is blank or over 160 characters. */
export function assertProjectName(name: string): void {
  if (!name.trim() || name.length > 160) {
    throw new Error("Choose a project name between 1 and 160 characters.");
  }
}

function createRecord<Manifest extends RunManifest | PairManifest>(
  name: string,
  manifest: Manifest,
): ProjectRecordOf<Manifest> {
  assertProjectName(name);

  const now = new Date().toISOString();

  return {
    version: 1,
    id: createLocalId(),
    name: name.trim(),
    createdAt: now,
    updatedAt: now,
    revision: 0,
    manifest,
    trust: "trusted",
  };
}

/** Checks a stored record and its manifest; throws when either is invalid. */
export function validateRecord(value: unknown): ProjectRecord {
  const fields = readRecordFields(value);

  return withManifest(fields, validateProjectManifest(fields.manifest));
}

const StoredRecordFieldsSchema = z.object({
  version: z.literal(1),
  id: z.string().check(z.minLength(1)),
  name: z.string().check(z.refine((name) => name.trim() !== "")),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  revision: IntegerSchema.check(z.gte(0)),
  manifest: z.optional(z.unknown()),
  origin: z.optional(z.literal("community")),
  source: z.optional(ProjectSourceSchema),
  trust: z.enum(["trusted", "untrusted"]),
});

/** A stored record's own fields, with its manifest left for the caller to validate. */
function readRecordFields(value: unknown): Omit<ProjectRecord, "manifest"> & { manifest: unknown } {
  const parsed = StoredRecordFieldsSchema.safeParse(value);

  if (!parsed.success) {
    throw new Error("A stored project is invalid. Its original record remains in browser storage.", {
      cause: parsed.error,
    });
  }

  const { manifest, origin, source, ...record } = parsed.data;

  return {
    ...record,
    manifest,
    ...(origin === undefined ? {} : { origin }),
    ...(source === undefined ? {} : { source }),
  };
}

/**
 * A removed pair a project or snapshot needs a release for: the whole project, or one side of a side by side.
 */
export interface RetiredRelease extends RetiredPair {
  /** The side on the removed pair, for a side by side. */
  side?: PairSideIndex;
  /** The side's name, when it has one. */
  name?: string;
  /** The manifest that runs on the removed pair, used to offer only pairs that can open it. */
  manifest: unknown;
}

/** A supported pair and flavor chosen for one retired release. */
export interface ChosenRelease {
  tupleId: RuntimeTupleId;
  guestFlavor?: GuestFlavor;
}

/** A stored project that is valid except for ORM/Kit pairs Drizzle Run no longer ships. */
export interface RetiredPairProject {
  id: string;
  name: string;
  /** The stored manifest, as written for the removed pairs. */
  manifest: unknown;
  /** The removed pairs to choose a release for: one, or one per side on a removed pair. */
  releases: readonly RetiredRelease[];
  /** The stored record, left untouched until a new pair is chosen. */
  record: unknown;
}

/**
 * Moves a manifest on removed pairs to the releases chosen for them, in the order of `releases`
 *
 * A side by side moves each listed side and checks every file path; a side on an older Legacy version follows the
 * Legacy pair. Throws when a choice is missing or the result is invalid.
 */
function moveToChosenReleases(
  manifest: unknown,
  releases: readonly RetiredRelease[],
  choices: readonly ChosenRelease[],
): RunManifest | PairManifest {
  const chosen = releases.map((release, index) => {
    const choice = choices[index];

    if (choice === undefined) {
      throw new Error(`Choose a Drizzle release for orm ${release.ormVersion} · kit ${release.kitVersion}.`);
    }

    return { release, tuple: getTupleForTarget(release.target, choice.tupleId), guestFlavor: choice.guestFlavor };
  });

  if (!isPairManifestLike(manifest)) {
    const [first] = chosen;

    if (first === undefined) {
      throw new Error("Choose a Drizzle release for this project.");
    }

    return validateManifest(moveManifestToPair(manifest, first.tuple, first.guestFlavor));
  }

  const sideReleases = chosen.flatMap(({ release, tuple, guestFlavor }) =>
    release.side === undefined ? [] : [{ side: release.side, tuple, guestFlavor }],
  );

  return validatePairManifest(moveRetiredPairSides(manifest, sideReleases));
}

const StoredSharedFilesSchema = z.looseObject({ files: z.record(z.string(), z.unknown()) });

/**
 * Whether the releases chosen for a side by side give each side its own copy of files it shares
 *
 * Legacy next to v1 shares only seed.ts, so a choice that puts the sides on different release lines splits the other
 * shared files. False for a one-version project, or for a choice that cannot open the manifest: choosing it reports
 * why.
 */
export function splitsSharedFiles(
  manifest: unknown,
  releases: readonly RetiredRelease[],
  choices: readonly ChosenRelease[],
): boolean {
  const stored = StoredSharedFilesSchema.safeParse(manifest);

  if (!stored.success || !isPairManifestLike(manifest)) {
    return false;
  }

  let moved: RunManifest | PairManifest;

  try {
    moved = moveToChosenReleases(manifest, releases, choices);
  } catch {
    return false;
  }

  return Object.keys(stored.data.files).some((path) => path !== PAIR_SEED_PATH && !Object.hasOwn(moved.files, path));
}

/** The tested pairs a manifest can move to: each one it validates on. */
export function listMovablePairs(manifest: unknown, target: RunManifestTarget): SupportedRuntimeTuple[] {
  return listSupportedTuples(target).filter((tuple) => {
    try {
      moveManifestToPair(manifest, tuple);

      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Lists the removed pairs a manifest needs a release chosen for
 *
 * One for a project on a removed pair, and one per side for a side by side with sides on removed pairs. A supported
 * pair must be the only change it needs to validate, and older Legacy versions follow the Legacy pair on their own.
 * Undefined when there is nothing to choose, or the manifest has another problem.
 */
export function listRetiredReleases(manifest: unknown): readonly RetiredRelease[] | undefined {
  if (isPairManifestLike(manifest)) {
    return findRetiredPairSides(manifest);
  }

  const pair = findRetiredPair(manifest);

  return pair && !inPlaceSuccessor(pair) ? [{ ...pair, manifest }] : undefined;
}

/**
 * Recognizes a project record on removed pairs that needs a choice, as `listRetiredReleases` lists them. Anything else
 * stays a preserved record.
 */
export function resolveRetiredPairProject(value: unknown): RetiredPairProject | undefined {
  try {
    const fields = readRecordFields(value);
    const releases = listRetiredReleases(fields.manifest);

    return releases && { id: fields.id, name: fields.name, manifest: fields.manifest, releases, record: value };
  } catch {
    return undefined;
  }
}

/**
 * Moves a retired-pair project to the chosen pairs and flavors, one per release it lists; files and history stay.
 */
export function chooseRelease(retired: RetiredPairProject, choices: readonly ChosenRelease[]): ProjectRecord {
  const fields = readRecordFields(retired.record);
  const manifest = moveToChosenReleases(fields.manifest, retired.releases, choices);

  return withManifest({ ...fields, revision: fields.revision + 1, updatedAt: new Date().toISOString() }, manifest);
}

/**
 * A temporary project from a shared snapshot. A snapshot on an older Legacy
 * version opens on the Legacy pair; one on a removed Next pair is undefined
 * until a release is chosen with `openRetiredSnapshot`.
 */
export function openSharedSnapshot(
  shared: { snapshot: PlaygroundSnapshot } | { snapshot: RetiredPairSnapshot; retiredPair: RetiredPair },
): ProjectRecord | undefined {
  if (!("retiredPair" in shared)) {
    return toCommunityProject(createProjectFromManifest(shared.snapshot.name, shared.snapshot.manifest));
  }

  if (listRetiredReleases(shared.snapshot.manifest) !== undefined) {
    return undefined;
  }

  return toCommunityProject(
    createProjectFromManifest(shared.snapshot.name, validateProjectManifest(shared.snapshot.manifest)),
  );
}

/** A project file written for pairs Drizzle Run no longer ships: it imports once a release is chosen for each. */
export interface RetiredProjectImport {
  /** Keys the chooser's form, as a stored project's id does. */
  id: string;
  name: string;
  /** The manifest as the file wrote it, for the removed pairs. */
  manifest: unknown;
  /** The removed pairs to choose a release for, from `listRetiredReleases`. */
  releases: readonly RetiredRelease[];
  /** Someone else's code, such as a snapshot, imports untrusted; a community export keeps the trust it had. */
  community: { trust: "trusted" | "untrusted" } | undefined;
}

/** The project a retired import becomes on the releases chosen for it, one per release it lists. */
export function chooseImportRelease(retired: RetiredProjectImport, choices: readonly ChosenRelease[]): ProjectRecord {
  const project = createProjectFromManifest(
    retired.name,
    moveToChosenReleases(retired.manifest, retired.releases, choices),
  );

  return retired.community === undefined
    ? project
    : { ...project, origin: "community", trust: retired.community.trust };
}

/**
 * A temporary project from a shared snapshot whose pairs left the catalog, on the pairs chosen for `releases`, which
 * `listRetiredReleases` gives for its manifest.
 */
export function openRetiredSnapshot(
  snapshot: RetiredPairSnapshot,
  releases: readonly RetiredRelease[],
  choices: readonly ChosenRelease[],
): ProjectRecord {
  return toCommunityProject(
    createProjectFromManifest(snapshot.name, moveToChosenReleases(snapshot.manifest, releases, choices)),
  );
}

/**
 * The next revision of the project with a new manifest or name. Throws when the name is blank or over 160 characters,
 * or the manifest is invalid.
 */
export function editProject(project: OneVersionProject, manifest?: RunManifest, name?: string): OneVersionProject;

export function editProject(project: SideBySideProject, manifest?: PairManifest, name?: string): SideBySideProject;

export function editProject(
  project: ProjectRecord,
  manifest?: RunManifest | PairManifest,
  name?: string,
): ProjectRecord;

export function editProject(
  project: ProjectRecord,
  manifest: RunManifest | PairManifest = project.manifest,
  name = project.name,
): ProjectRecord {
  assertProjectName(name);

  return withManifest(
    { ...project, name: name.trim(), revision: project.revision + 1, updatedAt: new Date().toISOString() },
    validateProjectManifest(manifest),
  );
}

/**
 * Throws when `path` names a file of `paths` in another case, such as `Schema.ts` next to `schema.ts`
 *
 * Such names are one file on a case-insensitive disk, which an export may end up on.
 */
function assertNoCaseTwin(paths: Iterable<string>, path: string): void {
  const lowerPath = path.toLowerCase();

  for (const existing of paths) {
    if (existing !== path && existing.toLowerCase() === lowerPath) {
      throw new Error(`That file already exists as ${existing}.`);
    }
  }
}

/** Creates, renames or deletes a helper file; throws for an entry file, a taken name or a missing file. */
export function applyHelperOperation(
  project: OneVersionProject,
  operation: "create" | "rename" | "delete",
  path: string,
  nextPath?: string,
): OneVersionProject {
  validateFilePath(path);

  if (Object.values(project.manifest.entrypoints).includes(path)) {
    throw new Error(operation === "create" ? "That file already exists." : "Entry filenames are fixed.");
  }

  const files = { ...project.manifest.files };

  if (operation === "create") {
    if (Object.hasOwn(files, path)) {
      throw new Error("That file already exists.");
    }

    assertNoCaseTwin(Object.keys(files), path);

    if (Object.keys(files).length >= 64) {
      throw new Error("Projects support up to 64 files.");
    }

    files[path] = path.endsWith(".json") ? "{}\n" : path.endsWith(".sql") ? "-- SQL migration\n" : "export {};\n";
  } else {
    if (!Object.hasOwn(files, path)) {
      throw new Error("File not found.");
    }

    if (operation === "rename") {
      const destination = validateFilePath(nextPath ?? "");

      if (Object.hasOwn(files, destination)) {
        throw new Error("That file already exists.");
      }

      assertNoCaseTwin(
        Object.keys(files).filter((existing) => existing !== path),
        destination,
      );

      files[destination] = files[path];
    }

    delete files[path];
  }

  return editProject(project, { ...project.manifest, files });
}

/**
 * Moves the project to another tested pair and guest flavor
 *
 * Throws for a pair the catalog does not test, and for one whose guest does not ship a package the files import.
 */
export function changeVersion(
  project: OneVersionProject,
  ormVersion: RuntimeTupleSelection["ormVersion"],
  kitVersion: RuntimeTupleSelection["kitVersion"],
  guestFlavor?: GuestFlavor,
): OneVersionProject {
  const tuple = resolveSupportedTuple({
    target: getCatalogTarget(project.manifest),
    ormVersion,
    kitVersion,
  });
  const currentFlavor = resolveGuestFlavor(project.manifest);
  const nextFlavor = guestFlavor ?? (hasGuestFlavor(tuple, currentFlavor) ? currentFlavor : "slim");
  const manifest = {
    ...project.manifest,
    dependencies: { "drizzle-orm": ormVersion, "drizzle-kit": kitVersion },
    guestFlavor: nextFlavor,
  };
  const validated = validateManifest(manifest);

  assertImportsAvailable(validated);

  return editProject(project, validated);
}

/** Writes a file from one side: a shared file changes on both sides. */
export function editSideFile(
  project: SideBySideProject,
  side: PairSideIndex,
  path: string,
  contents: string,
): SideBySideProject {
  return editProject(project, editPairFile(project.manifest, side, path, contents));
}

/** Gives each side its own copy of a shared file. */
export function splitSideFile(project: SideBySideProject, path: string): SideBySideProject {
  return editProject(project, splitPairFile(project.manifest, path));
}

/** Makes a per-side file one shared file, keeping `from`'s copy. */
export function shareSideFile(project: SideBySideProject, path: string, from: PairSideIndex): SideBySideProject {
  return editProject(project, sharePairFile(project.manifest, path, from));
}

/**
 * Moves one side to another tested pair and guest flavor, on either database, naming any package that pair does not
 * ship
 */
export function changeSideVersion(
  project: SideBySideProject,
  side: PairSideIndex,
  tupleId: RuntimeTupleId,
  files: PairSideFiles,
  guestFlavor?: GuestFlavor,
): SideBySideProject {
  return editProject(project, changePairSide(project.manifest, side, getTuple(tupleId), files, guestFlavor));
}

/** Names one side, or clears its name when `sideName` is empty so it goes by its release. */
export function renameSide(project: SideBySideProject, side: PairSideIndex, sideName: string): SideBySideProject {
  return editProject(project, renamePairSide(project.manifest, side, sideName));
}

/** Swaps the two sides of a side-by-side project. */
export function swapSides(project: SideBySideProject): SideBySideProject {
  return editProject(project, swapPairSides(project.manifest));
}

/** The tested pair each side runs on. */
export function getSideTuples(manifest: PairManifest): readonly [SupportedRuntimeTuple, SupportedRuntimeTuple] {
  return [pairSideTuple(manifest, 0), pairSideTuple(manifest, 1)];
}

/**
 * Creates, renames or deletes a helper file of a side-by-side project. A new helper is
 * shared, or gets a copy per side for a Legacy side next to a v1 side; a per-side helper is
 * renamed or deleted on both sides.
 */
export function applySideHelperOperation(
  project: SideBySideProject,
  operation: "create" | "rename" | "delete",
  path: string,
  nextPath?: string,
): SideBySideProject {
  validateFilePath(path);

  const { manifest } = project;

  if (Object.values(manifest.entrypoints).includes(path)) {
    throw new Error(operation === "create" ? "That file already exists." : "Entry filenames are fixed.");
  }

  const shared = isSharedPairFile(manifest, path);
  const exists = shared || Object.hasOwn(manifest.sides[0].files, path);
  const taken = (name: string) => Object.hasOwn(manifest.files, name) || Object.hasOwn(manifest.sides[0].files, name);

  const pairPaths = [...Object.keys(manifest.files), ...Object.keys(manifest.sides[0].files)];

  if (operation === "create") {
    if (exists) {
      throw new Error("That file already exists.");
    }

    assertNoCaseTwin(pairPaths, path);

    return editProject(project, addPairFile(manifest, path, path.endsWith(".json") ? "{}\n" : "export {};\n"));
  }

  if (!exists) {
    throw new Error("File not found.");
  }

  const destination = operation === "rename" ? validateFilePath(nextPath ?? "") : undefined;

  if (destination !== undefined && taken(destination)) {
    throw new Error("That file already exists.");
  }

  if (destination !== undefined) {
    assertNoCaseTwin(
      pairPaths.filter((existing) => existing !== path),
      destination,
    );
  }

  const move = (files: Record<string, string>) => {
    const next = { ...files };

    if (Object.hasOwn(next, path)) {
      if (destination !== undefined) {
        next[destination] = next[path] ?? "";
      }

      delete next[path];
    }

    return next;
  };

  return editProject(project, {
    ...manifest,
    files: move(manifest.files),
    sides: [
      { ...manifest.sides[0], files: move(manifest.sides[0].files) },
      { ...manifest.sides[1], files: move(manifest.sides[1].files) },
    ],
  });
}
