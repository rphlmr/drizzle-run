import { DIALECT_IDS, GUEST_FLAVORS, type GuestFlavor } from "@drizzle-run/core/catalog";
import { isPairProject, type GuideManifest, type GuideProject } from "@drizzle-run/core/guide";
import type { RunManifest, RunManifestTarget } from "@drizzle-run/core/manifest";
import {
  PAIR_MANIFEST_KIND,
  PAIR_MANIFEST_VERSION,
  PAIR_SIDES,
  pairSide,
  type PairManifest,
} from "@drizzle-run/core/pair";
import * as z from "zod/mini";

import { isPairGuide, listGuideVersions, type GuideVersion } from "../guides/catalog";
import { getErrorText } from "../lib/error-text";
import { FieldsSchema, IntegerSchema } from "../lib/records";
import {
  CatalogStatusSchema,
  checkVersions,
  pickShown,
  SHOWS_DRAFTS,
  SLUG_FORMAT,
  SlugSchema,
  VersionIdSchema,
  type CatalogVersion,
} from "../official/versions";
import { isPairManifest, validateManifest, validatePairManifest } from "../project/projects";
import { ExampleError, parseLink, readExampleField, readRequiredText, type ExampleLink } from "./source";

export { DOCS_ORIGIN, ExampleError, NOTES_ORIGIN, type ExampleLink } from "./source";

/** The gallery's topics, in the order its filter lists them. */
export const EXAMPLE_TOPICS = [
  "Queries",
  "Helpers",
  "JSON",
  "Pagination",
  "RQB",
  "Schema",
  "Transactions",
  "Migrations",
  "Seeding",
  "Validation",
  "Effect",
] as const;
/** A topic an example is filed under. */
export type ExampleTopic = (typeof EXAMPLE_TOPICS)[number];

/** The gallery's sections, in the order it shows them: each example sits in exactly one. */
export const EXAMPLE_SECTIONS = [
  { id: "start", label: "Start here" },
  { id: "querying", label: "Querying" },
  { id: "pagination", label: "Paginate" },
  { id: "json", label: "Work with JSON" },
  { id: "relational-queries", label: "Relational queries" },
  { id: "helpers", label: "Typed helpers" },
  { id: "schema", label: "Schema & dates" },
  { id: "writes", label: "Writes & validation" },
  { id: "integrations", label: "Integrations" },
] as const;
/** The gallery section an example sits in. */
export type ExampleSectionId = (typeof EXAMPLE_SECTIONS)[number]["id"];

/** One version of an official example, parsed from its folder under `examples/`. */
export interface OfficialExample extends CatalogVersion {
  /** Its folder under `examples/`, where its files and recording live. */
  folder: string;
  title: string;
  description: string;
  topics: readonly ExampleTopic[];
  section: ExampleSectionId;
  order: number;
  links: readonly ExampleLink[];
  /** One version, or both sides of a side-by-side example. */
  manifest: RunManifest | PairManifest;
  /** The guide shown for this version, whose `meta.example` is its id: the example then opens guided. */
  guide?: GuideManifest;
  /** The guide's folder under `guides/`, where its recordings live; present with `guide`. */
  guideFolder?: string;
}

/**
 * One folder under `examples/`: its `example.json`, the files under `files/` and, for a side-by-side example, the files
 * each side runs on its own, under `sides/1/` and `sides/2/`.
 */
export interface ExampleSource {
  folder: string;
  metadata: unknown;
  files: Record<string, string>;
  sideFiles?: readonly [Record<string, string>, Record<string, string>];
}

const METADATA_FIELDS = new Set([
  "id",
  "slug",
  "status",
  "title",
  "description",
  "topics",
  "section",
  "order",
  "dialect",
  "releasePair",
  "guestFlavor",
  "sides",
  "randomSeed",
  "links",
]);
const PAIR_ID = /^orm-([^_]+)__kit-([^_]+)$/;

const ExampleTopicSchema = z.enum(EXAMPLE_TOPICS);
const ExampleSectionSchema = z.enum(EXAMPLE_SECTIONS.map(({ id }) => id));
const ExampleDialectSchema = z.enum(DIALECT_IDS);
const ExampleGuestFlavorSchema = z.enum(GUEST_FLAVORS);

const ReleasePairSchema = z.pipe(
  z.string(),
  z.transform((value, context) => {
    const match = PAIR_ID.exec(value);

    if (!match) {
      context.issues.push({
        code: "custom",
        message: `Expected orm-<version>__kit-<version>, but got ${value}`,
        input: value,
      });
      return z.NEVER;
    }

    return { orm: match[1], kit: match[2] };
  }),
);

/**
 * Both sides of a side-by-side example, in side order: the name each goes by, and the database, release pair and guest
 * flavor it runs. A side without its own runs the example's `dialect`, `releasePair` and `guestFlavor`.
 */
const ExampleSideSchema = z.strictObject({
  name: z.string(),
  dialect: z.optional(ExampleDialectSchema),
  releasePair: z.optional(ReleasePairSchema),
  guestFlavor: z.optional(ExampleGuestFlavorSchema),
});
const ExampleSidesSchema = z.tuple([ExampleSideSchema, ExampleSideSchema]);

/** What one version, or one side, of an example runs: its database, its pair and its guest flavor. */
interface ExampleRun {
  dialect: RunManifestTarget["dialect"];
  dependencies: { "drizzle-orm": string; "drizzle-kit": string };
  guestFlavor: GuestFlavor | undefined;
}

/** The example's own database, pair and flavor, as `example.json` states them; each may be left to the sides. */
interface ExampleDefaults {
  dialect: RunManifestTarget["dialect"] | undefined;
  pair: { orm: string; kit: string } | undefined;
  guestFlavor: GuestFlavor | undefined;
}

/**
 * Resolve what one side, or the one version, runs: its own database, pair and flavor, else the example's
 *
 * Throws `ExampleError` when neither names a database or a pair.
 */
function resolveExampleRun(
  folder: string,
  defaults: ExampleDefaults,
  side: z.output<typeof ExampleSideSchema> | undefined,
): ExampleRun {
  const dialect = side?.dialect ?? defaults.dialect;
  const pair = side?.releasePair ?? defaults.pair;
  const where = side === undefined ? "example.json" : `example.json and side "${side.name}"`;

  if (dialect === undefined) {
    throw new ExampleError(folder, `${where} name no dialect: set ${DIALECT_IDS.join(" or ")}.`);
  }

  if (pair === undefined) {
    throw new ExampleError(folder, `${where} name no releasePair: set "orm-<version>__kit-<version>".`);
  }

  return {
    dialect,
    dependencies: { "drizzle-orm": pair.orm, "drizzle-kit": pair.kit },
    guestFlavor: side?.guestFlavor ?? defaults.guestFlavor,
  };
}

/** A run's manifest fields. The pair must ship the flavor; validation says so when it does not. */
function toRunFields({ dialect, dependencies, guestFlavor }: ExampleRun) {
  return {
    target: { dialect },
    dependencies,
    ...(guestFlavor === undefined ? {} : { guestFlavor }),
  };
}

/**
 * Validates one example folder and builds its manifest
 *
 * Errors name the folder. Versions, guides, and links between examples are checked by `loadExamples`.
 */
export function parseExample(source: ExampleSource): OfficialExample {
  const { folder, files } = source;

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(folder)) {
    throw new ExampleError(folder, "the folder name must be lowercase words joined by hyphens.");
  }

  const metadata = readExampleField(folder, FieldsSchema, source.metadata, "example.json must be an object.");
  const unknown = Object.keys(metadata).filter((field) => !METADATA_FIELDS.has(field));

  if (unknown.length > 0) {
    throw new ExampleError(folder, `example.json has unknown fields: ${unknown.join(", ")}.`);
  }

  const id = readExampleField(
    folder,
    VersionIdSchema,
    metadata.id,
    "id must be a lowercase UUID, new for each version.",
  );
  const slug = readExampleField(folder, SlugSchema, metadata.slug, `slug must be ${SLUG_FORMAT}.`);
  const status = readExampleField(
    folder,
    CatalogStatusSchema,
    metadata.status,
    "status must be published, draft, or deleted.",
  );

  const title = readRequiredText(folder, metadata, "title");
  const description = readRequiredText(folder, metadata, "description");
  const topics = readExampleField(
    folder,
    z.array(ExampleTopicSchema).check(
      z.minLength(1),
      z.refine((items) => new Set(items).size === items.length),
    ),
    metadata.topics,
    `topics must be a non-empty list of unique values from ${EXAMPLE_TOPICS.join(", ")}.`,
  );
  const section = readExampleField(
    folder,
    ExampleSectionSchema,
    metadata.section,
    `section must be one of ${EXAMPLE_SECTIONS.map((item) => item.id).join(", ")}.`,
  );
  const order = readExampleField(folder, IntegerSchema, metadata.order, "order must be an integer.");
  const dialect =
    metadata.dialect === undefined
      ? undefined
      : readExampleField(
          folder,
          ExampleDialectSchema,
          metadata.dialect,
          `dialect must be ${DIALECT_IDS.join(" or ")}.`,
        );
  const pair =
    metadata.releasePair === undefined
      ? undefined
      : readExampleField(
          folder,
          ReleasePairSchema,
          metadata.releasePair,
          'releasePair must look like "orm-<version>__kit-<version>".',
        );
  const guestFlavor =
    metadata.guestFlavor === undefined
      ? undefined
      : readExampleField(
          folder,
          ExampleGuestFlavorSchema,
          metadata.guestFlavor,
          `guestFlavor must be ${GUEST_FLAVORS.join(" or ")}.`,
        );
  const sides =
    metadata.sides === undefined
      ? undefined
      : readExampleField(
          folder,
          ExampleSidesSchema,
          metadata.sides,
          'sides must list two sides, each with a name and an optional dialect, releasePair and guestFlavor: [{ "name": "…" }, { "name": "…", "dialect": "sqlite" }].',
        );
  const links = readExampleField(folder, z.array(z.unknown()), metadata.links ?? [], "links must be a list.");

  if (sides === undefined && source.sideFiles !== undefined) {
    throw new ExampleError(folder, "sides/ holds files per side, so example.json must list its sides.");
  }

  const sideFiles = source.sideFiles ?? [{}, {}];

  for (const entry of ["schema.ts", "query.ts"]) {
    const perSide = sides !== undefined && sideFiles.every((side) => Object.hasOwn(side, entry));

    if (!Object.hasOwn(files, entry) && !perSide) {
      throw new ExampleError(
        folder,
        sides === undefined
          ? `files/${entry} is required.`
          : `${entry} is required, in files/ or in both sides/ folders.`,
      );
    }
  }

  if (sideFiles.some((side) => Object.hasOwn(side, "seed.ts"))) {
    throw new ExampleError(folder, "seed.ts is the seed file both sides share, so it belongs in files/.");
  }

  const defaults = { dialect, pair, guestFlavor };
  const entrypoints = {
    schema: "schema.ts",
    ...(Object.hasOwn(files, "seed.ts") ? { seed: "seed.ts" } : {}),
    run: "query.ts",
  };
  const randomSeed = metadata.randomSeed === undefined ? {} : { randomSeed: metadata.randomSeed };
  let manifest: RunManifest | PairManifest;

  try {
    manifest =
      sides === undefined
        ? validateManifest({
            kind: "drizzle-run",
            manifestVersion: 1,
            ...toRunFields(resolveExampleRun(folder, defaults, undefined)),
            entrypoints,
            files,
            ...randomSeed,
          })
        : validatePairManifest({
            kind: PAIR_MANIFEST_KIND,
            manifestVersion: PAIR_MANIFEST_VERSION,
            entrypoints,
            files,
            sides: [
              {
                name: sides[0].name,
                ...toRunFields(resolveExampleRun(folder, defaults, sides[0])),
                files: sideFiles[0],
              },
              {
                name: sides[1].name,
                ...toRunFields(resolveExampleRun(folder, defaults, sides[1])),
                files: sideFiles[1],
              },
            ],
            ...randomSeed,
          });
  } catch (cause) {
    if (cause instanceof ExampleError) {
      throw cause;
    }

    throw new ExampleError(folder, getErrorText(cause));
  }

  return {
    id,
    slug,
    status,
    folder,
    title,
    description,
    topics,
    section,
    order,
    links: links.map((link) => parseLink(folder, link)),
    manifest,
  };
}

/** The value with its object keys sorted, so two manifests compare whatever their key order. */
function toCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toCanonical);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, toCanonical(item)]),
    );
  }

  return value;
}

/** The files, pair, and seed a guide runs on, so it can only guide the example it starts from. */
function isSameProject(left: unknown, right: unknown) {
  return JSON.stringify(toCanonical(left)) === JSON.stringify(toCanonical(right));
}

/**
 * A side-by-side guide starts from the one-version example on one of its sides: that side runs the example's
 * pair and files. Ignore the side's seedGeneratorVersion and compare only the ORM and Kit dependency pins.
 * A guide of a side-by-side example starts from the example as it is.
 */
function startsFromExample(project: GuideProject, example: RunManifest | PairManifest) {
  if (isPairManifest(example) || !isPairProject(project)) {
    return isSameProject(project, example);
  }

  return PAIR_SIDES.some((side) => {
    const { dependencies, seedGeneratorVersion: _seedGeneratorVersion, ...rest } = pairSide(project, side);

    return isSameProject(
      {
        ...rest,
        dependencies: { "drizzle-orm": dependencies["drizzle-orm"], "drizzle-kit": dependencies["drizzle-kit"] },
      },
      example,
    );
  });
}

/** Checks that each guide walks an existing example version that it starts from, under the same slug. */
function checkGuides(examples: readonly OfficialExample[], guides: readonly GuideVersion[]) {
  for (const guide of guides) {
    if (guide.example === undefined) {
      continue;
    }

    const example = examples.find((item) => item.id === guide.example);
    const where = `guides/${guide.folder}`;

    if (!example) {
      throw new Error(`${where} walks the example version "${guide.example}", which does not exist.`);
    }

    if (guide.slug !== example.slug) {
      throw new ExampleError(example.folder, `${where} must have the example's slug "${example.slug}".`);
    }

    if (guide.status === "published" && example.status !== "published") {
      throw new ExampleError(example.folder, `${where} is published, so the example version it walks must be too.`);
    }

    if (!startsFromExample(guide.manifest.project, example.manifest)) {
      throw new ExampleError(example.folder, `${where} must start from the example's files, pair, and seed.`);
    }
  }
}

/**
 * Parses every example version and attaches the guides shown
 *
 * Checks ids and one published version per slug, each guide against the example version it walks, and links between
 * examples, then sorts by `order`, then title. Every version is returned, deleted ones included.
 *
 * @param drafts - Whether draft guides are shown, replacing the published version of their slug.
 */
export function loadExamples(
  sources: readonly ExampleSource[],
  guides: readonly GuideVersion[] = [],
  drafts: boolean = SHOWS_DRAFTS,
): OfficialExample[] {
  const parsed = sources.map(parseExample);

  checkVersions("example", parsed);
  checkGuides(parsed, guides);

  const shownGuides = pickShown(guides, drafts);
  const examples = parsed.map((example): OfficialExample => {
    const guide = shownGuides.find((item) => item.example === example.id);

    return guide ? { ...example, guide: guide.manifest, guideFolder: guide.folder } : example;
  });
  const liveExamples = examples.filter((example) => example.status !== "deleted");
  const slugs = new Set(liveExamples.map((example) => example.slug));

  for (const example of liveExamples) {
    for (const link of example.links) {
      if (link.kind === "example" && !slugs.has(link.slug)) {
        throw new ExampleError(example.folder, `link "${link.label}" points to "${link.slug}", which does not exist.`);
      }
    }
  }

  return examples.toSorted((left, right) => left.order - right.order || left.title.localeCompare(right.title));
}

const EXAMPLE_PATH = /^\.\.\/\.\.\/examples\/([^/]+)\/(?:example\.json|files\/(.+)|sides\/([12])\/(.+))$/;

/** The `import.meta.glob` results for the example folders, by file path. */
export interface GlobResults {
  metadata: Record<string, unknown>;
  files: Record<string, string>;
}

/** Groups the glob results by folder. */
export function collectSources({ metadata, files }: GlobResults): ExampleSource[] {
  const sources = new Map<string, ExampleSource>();
  const getOrCreateSource = (folder: string) => {
    let found = sources.get(folder);

    if (!found) {
      found = { folder, metadata: undefined, files: {} };
      sources.set(folder, found);
    }

    return found;
  };

  for (const [path, value] of Object.entries(metadata)) {
    const match = EXAMPLE_PATH.exec(path);

    if (match) {
      getOrCreateSource(match[1]).metadata = value;
    }
  }

  for (const [path, value] of Object.entries(files)) {
    const match = EXAMPLE_PATH.exec(path);

    if (match?.[2]) {
      getOrCreateSource(match[1]).files[match[2]] = value;
    }

    if (match?.[3] && match[4]) {
      const source = getOrCreateSource(match[1]);
      const sideFiles = source.sideFiles ?? [{}, {}];

      sideFiles[match[3] === "1" ? 0 : 1][match[4]] = value;
      source.sideFiles = sideFiles;
    }
  }

  return [...sources.values()];
}

let exampleVersions: readonly OfficialExample[] | undefined;
let shownExamples: readonly OfficialExample[] | undefined;

/**
 * Every official example version, deleted ones included, in gallery order
 *
 * Loaded on first use, so scripts outside Vite can import this module's parsers without its `import.meta.glob`.
 */
export function listExampleVersions(): readonly OfficialExample[] {
  exampleVersions ??= loadExamples(
    collectSources({
      metadata: import.meta.glob<unknown>("../../examples/*/example.json", { eager: true, import: "default" }),
      files: import.meta.glob<string>(["../../examples/*/files/**/*", "../../examples/*/sides/*/**/*"], {
        eager: true,
        query: "?raw",
        import: "default",
      }),
    }),
    listGuideVersions(),
  );

  return exampleVersions;
}

/** The official examples shown, in gallery order: one per slug, published or, in development, the draft replacing it. */
export function listExamples(): readonly OfficialExample[] {
  shownExamples ??= pickShown(listExampleVersions());

  return shownExamples;
}

/** The official example shown at this permanent slug, if there is one. */
export function findExample(slug: string): OfficialExample | undefined {
  return listExamples().find((example) => example.slug === slug);
}

/** The pair by its ORM version, as the gallery shows it: "orm 0.45.4", titled "ORM 0.45.4 with Kit 0.31.11". */
export function getPairLabel(manifest: RunManifest): { label: string; title: string } {
  const orm = manifest.dependencies["drizzle-orm"];

  return { label: `orm ${orm}`, title: `ORM ${orm} with Kit ${manifest.dependencies["drizzle-kit"]}` };
}

/** One side of a side-by-side example, as its gallery card names it. */
export interface ExampleSide {
  /** The side's name; absent when it goes by its release. */
  name?: string;
  ormVersion: string;
}

/**
 * The sides a side-by-side example or its side-by-side guide compares, in side order
 *
 * Returns `null` for an example that runs on one release, including one whose guide splits at some steps only.
 */
export function resolveExampleSides(example: OfficialExample): [ExampleSide, ExampleSide] | null {
  const guide = example.guide && isPairGuide(example.guide) ? example.guide : undefined;
  const project = isPairManifest(example.manifest) ? example.manifest : guide?.project;

  if (project === undefined || !isPairProject(project)) {
    return null;
  }

  const [first, second] = PAIR_SIDES.map((side) => ({
    ...(project.sides[side].name === undefined ? {} : { name: project.sides[side].name }),
    ormVersion: pairSide(project, side).dependencies["drizzle-orm"],
  }));

  return [first, second];
}

/** The guided example after `slug` in gallery order, for the "Next guide" link. */
export function findNextGuidedExample(
  slug: string,
  examples: readonly OfficialExample[] = listExamples(),
): OfficialExample | undefined {
  const guided = examples.filter((example) => example.guide);
  const index = guided.findIndex((example) => example.slug === slug);

  return index === -1 ? undefined : (guided[index + 1] ?? (guided[0]?.slug === slug ? undefined : guided[0]));
}
