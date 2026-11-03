import { findRetiredPairSnapshot, parsePlaygroundSnapshot } from "@drizzle-run/core/contracts";
import * as z from "zod/mini";

import { FieldsSchema } from "../lib/records";
import { createLocalId } from "./local-id";
import {
  assertProjectName,
  createProjectFromManifest,
  listRetiredReleases,
  toCommunityProject,
  validateProjectManifest,
  type ProjectRecord,
  type RetiredProjectImport,
} from "./projects";

const ProjectFileSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  manifest: z.unknown(),
  origin: z.catch(z.optional(z.literal("community")), undefined),
  trust: z.catch(z.optional(z.enum(["trusted", "untrusted"])), undefined),
});

/**
 * What an imported JSON file was
 *
 * `project`: a Drizzle Run project export, the only file that may carry a share link. `snapshot`: a published
 * snapshot, which is someone else's code. `manifest`: a bare manifest.
 */
export type ProjectFileFormat = "project" | "snapshot" | "manifest";

/** A project read from a JSON file, with the format the file had. */
export interface ImportedProjectFile {
  project: ProjectRecord;
  format: ProjectFileFormat;
  /** Says the file's older Legacy release moved to the Legacy pair, such as for an export made on 0.44.0. */
  releaseNote?: string;
}

const DependencyPinsSchema = z.object({ "drizzle-orm": z.string(), "drizzle-kit": z.string() });
const ManifestPinsSchema = z.union([
  z.object({ sides: z.array(z.object({ dependencies: DependencyPinsSchema })) }),
  z.object({ dependencies: DependencyPinsSchema }),
]);

/** The ORM and Kit pins of a one-version manifest, or of each side; empty when it has none to read. */
function readDependencyPins(manifest: unknown): string[] {
  const parsed = ManifestPinsSchema.safeParse(manifest);

  if (!parsed.success) {
    return [];
  }

  const pins = "sides" in parsed.data ? parsed.data.sides.map((side) => side.dependencies) : [parsed.data.dependencies];

  return pins.map((pin) => `orm ${pin["drizzle-orm"]} · kit ${pin["drizzle-kit"]}`);
}

/** The project with a note when it opens on another release than the file wrote, as an older Legacy one does. */
function withReleaseNote(imported: Omit<ImportedProjectFile, "releaseNote">, written: unknown): ImportedProjectFile {
  const before = readDependencyPins(written);
  const after = readDependencyPins(imported.project.manifest);
  const moves = before.flatMap((pin, index) => {
    const moved = after[index];

    return moved !== undefined && moved !== pin ? [`${pin} to ${moved}`] : [];
  });

  if (moves.length === 0) {
    return imported;
  }

  return {
    ...imported,
    releaseNote: `“${imported.project.name}” moved from ${moves.join(" and from ")}: Drizzle Run no longer ships the release it was written for.`,
  };
}

/**
 * Thrown by `importProjectValue` for a project on removed pairs: the file is readable once a release is chosen
 *
 * `format` is the kind of file it came from, as `ImportedProjectFile` says it: only a project export carries a sharing
 * key.
 */
export class RetiredProjectImportError extends Error {
  readonly retired: RetiredProjectImport;
  readonly format: ProjectFileFormat;

  constructor(retired: RetiredProjectImport, format: ProjectFileFormat) {
    super(`“${retired.name}” uses a Drizzle release this version no longer ships. Choose a release to import it.`);
    this.name = "RetiredProjectImportError";
    this.retired = retired;
    this.format = format;
  }
}

/**
 * Throws `RetiredProjectImportError` when `manifest` is on removed pairs that need a release chosen
 *
 * The name is checked first, so a file no release can import fails now rather than after the choice.
 */
function assertNoRetiredReleases(
  { name, manifest, community }: Pick<RetiredProjectImport, "name" | "manifest" | "community">,
  format: ProjectFileFormat,
) {
  const releases = listRetiredReleases(manifest);

  if (releases === undefined) {
    return;
  }

  assertProjectName(name);

  throw new RetiredProjectImportError({ id: createLocalId(), name, manifest, releases, community }, format);
}

/** The parsed JSON of a picked file; throws a message the person can act on when it is not JSON. */
export function readProjectJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (cause) {
    throw new Error("This file is not JSON. Pick a project or a backup exported from Drizzle Run.", { cause });
  }
}

/**
 * Import one parsed project file as a fresh local project
 *
 * A published snapshot imports as someone else's project, untrusted. A project export keeps its origin and trust; an
 * export without them is the user's own. Throws when the value is not a project.
 */
export function importProjectValue(value: unknown): ImportedProjectFile {
  const fields = FieldsSchema.safeParse(value);

  if (!fields.success) {
    throw new Error("Invalid project JSON.", { cause: fields.error });
  }

  const record = fields.data;

  if (Object.hasOwn(record, "snapshotVersion")) {
    const retiredSnapshot = findRetiredPairSnapshot(value);

    if (retiredSnapshot !== undefined) {
      const { name, manifest } = retiredSnapshot.snapshot;
      assertNoRetiredReleases({ name, manifest, community: { trust: "untrusted" } }, "snapshot");
    }

    const snapshot = parsePlaygroundSnapshot(value);

    return withReleaseNote(
      { project: toCommunityProject(createProjectFromManifest(snapshot.name, snapshot.manifest)), format: "snapshot" },
      record.manifest,
    );
  }

  const projectFile = ProjectFileSchema.safeParse(record);

  if (projectFile.success) {
    const { name, manifest, origin, trust } = projectFile.data;

    assertNoRetiredReleases(
      { name, manifest, community: origin === "community" ? { trust: trust ?? "untrusted" } : undefined },
      "project",
    );
    const project = createProjectFromManifest(name, validateProjectManifest(manifest));

    if (origin !== "community") {
      return withReleaseNote({ project, format: "project" }, manifest);
    }

    return withReleaseNote(
      { project: { ...project, origin, trust: trust ?? "untrusted" }, format: "project" },
      manifest,
    );
  }

  if (Object.hasOwn(record, "kind")) {
    assertNoRetiredReleases({ name: "Imported project", manifest: value, community: undefined }, "manifest");

    return withReleaseNote(
      { project: createProjectFromManifest("Imported project", validateProjectManifest(value)), format: "manifest" },
      value,
    );
  }

  throw new Error("Unsupported project JSON. Expected a project record or Drizzle Run manifest.");
}
