import { resolveSupportedTuple } from "@drizzle-run/core/catalog";
import type { GuideManifest } from "@drizzle-run/core/guide";
import type { RunManifest } from "@drizzle-run/core/manifest";
import { createPairManifest, PAIR_SIDES, pairSide, pairSideLabels } from "@drizzle-run/core/pair";
import { pick } from "es-toolkit";
import { describe, expect, it } from "vitest";

import { listGuideVersions, type GuideVersion } from "../guides/catalog";
import { isPairManifest } from "../project/projects";
import {
  collectSources,
  findExample,
  findNextGuidedExample,
  getExampleKind,
  getPairLabel,
  listExamples,
  listExampleTopics,
  loadExamples,
  parseExample,
  resolveExampleSides,
  type ExampleSource,
  type OfficialExample,
} from "./catalog";

const files = {
  "schema.ts":
    'import { sqliteTable, integer } from "drizzle-orm/sqlite-core";\n\nexport const items = sqliteTable("items", { id: integer("id").primaryKey() });\n',
  "seed.ts": "export {};\n",
  "query.ts": "export {};\n",
};

const SAMPLE_ID = "00000000-0000-4000-8000-000000000001";

function makeSource(metadata: Record<string, unknown> = {}, folder = "sample"): ExampleSource {
  return {
    folder,
    metadata: {
      id: SAMPLE_ID,
      slug: folder,
      status: "published",
      title: "Sample",
      description: "A sample.",
      topic: "Queries",
      featured: false,
      order: 1,
      dialect: "sqlite",
      releasePair: "orm-0.45.4__kit-0.31.11",
      ...metadata,
    },
    files,
  };
}

function makeSideBySideSource(metadata: Record<string, unknown> = {}): ExampleSource {
  const { "query.ts": query, ...shared } = files;

  return {
    ...makeSource({ sides: [{ name: "Classic" }, { name: "RQB" }], ...metadata }),
    files: shared,
    sideFiles: [{ "query.ts": query }, { "query.ts": "export const other = 1;\n" }],
  };
}

/** The manifest of a one-version example; throws for a side-by-side one. */
function getOneVersionManifest(example: OfficialExample): RunManifest {
  if (isPairManifest(example.manifest)) {
    throw new Error(`Expected ${example.folder} to run on one version, but it is side by side.`);
  }

  return example.manifest;
}

/** What an example runs: its one version, or each side in side order. */
function listExampleRuns({ manifest }: OfficialExample): RunManifest[] {
  return isPairManifest(manifest) ? PAIR_SIDES.map((side) => pairSide(manifest, side)) : [manifest];
}

describe("official examples in the repository", () => {
  it("should parse and run every example on a tested pair", () => {
    const examples = listExamples();

    expect(examples.length).toBeGreaterThanOrEqual(6);

    for (const run of examples.flatMap(listExampleRuns)) {
      expect(run.entrypoints.run).toBe("query.ts");
      expect(Object.values(run.files).some((source) => source.includes("@drizzle-run/runtime/context"))).toBe(true);
    }
  });

  it("should sort by order and find each example by slug", () => {
    const orders = listExamples().map((example) => example.order);

    expect(orders).toEqual(orders.toSorted((left, right) => left - right));
    expect(findExample("quick-start-postgresql")?.manifest).toMatchObject({ target: { dialect: "postgresql" } });
    expect(findExample("missing")).toBeUndefined();
  });

  it("should have one featured example and the bundled quick starts", () => {
    expect(listExamples().filter((example) => example.featured)).toHaveLength(1);
    expect(findExample("quick-start-sqlite")?.manifest).toMatchObject({ target: { dialect: "sqlite" } });
  });

  it("should feature a guided example and open the guides that share a slug", () => {
    const featured = listExamples().find((example) => example.featured);

    expect(featured?.guide?.steps.length).toBeGreaterThan(1);
    expect(
      listExamples()
        .filter((example) => getExampleKind(example) === "guided")
        .map(({ slug }) => slug)
        .toSorted(),
    ).toEqual([
      "drizzle-in-five-minutes",
      "drizzle-with-effect",
      "helper-apis-postgresql",
      "helper-apis-sqlite",
      "joins-explained",
      "nested-sql-results",
      "pagination-apis-postgresql",
      "pagination-apis-sqlite",
      "pagination-postgresql",
      "pagination-sqlite",
      "prepared-queries",
      "relational-queries",
      "reusable-helpers",
      "reusable-helpers-sqlite",
      "select-vs-relational-queries",
      "subqueries",
      "temporal-custom-type-postgresql",
      "temporal-custom-type-sqlite",
      "transactions",
    ]);
  });

  it("should run every official example on the rc.5 pair, named by its ORM version", () => {
    for (const run of listExamples().flatMap(listExampleRuns)) {
      expect(getPairLabel(run)).toEqual({
        label: "orm 1.0.0-rc.5",
        title: "ORM 1.0.0-rc.5 with Kit 1.0.0-rc.5",
      });
    }
  });

  it("should keep the advanced starters independently editable instead of attaching guides", () => {
    for (const slug of [
      "files-with-comments-and-tags",
      "jsonb-product-filters",
      "jsonb-preference-updates",
      "prepared-product-search",
      "author-report",
    ]) {
      const example = findExample(slug);

      expect(example, slug).toBeDefined();
      expect(example?.guide, slug).toBeUndefined();
    }
  });

  it("should link each guided example to the next one, and the last back to the first", () => {
    const guided = listExamples().filter((example) => example.guide);

    expect(guided.length).toBeGreaterThan(2);
    expect(findNextGuidedExample(guided[0].slug)?.slug).toBe(guided[1].slug);
    expect(findNextGuidedExample(guided[guided.length - 1].slug)?.slug).toBe(guided[0].slug);
    expect(findNextGuidedExample("quick-start-sqlite")).toBeUndefined();
  });

  it("should find a guide by the example version it walks", () => {
    const transactions = findExample("transactions");

    expect(transactions?.guide?.id).toBe(
      listGuideVersions().find((guide) => guide.example === transactions?.id)?.manifest.id,
    );
  });

  it("should open select vs relational queries side by side, SQL-like and RQB on one shared schema and seed", () => {
    const manifest = findExample("select-vs-relational-queries")?.manifest;

    if (manifest === undefined || !isPairManifest(manifest)) {
      throw new Error("Expected select-vs-relational-queries to be a side-by-side example.");
    }

    expect(pairSideLabels(manifest)).toEqual(["SQL-like", "RQB"]);
    expect(Object.keys(manifest.files).toSorted()).toEqual(["schema.ts", "seed.ts"]);
    expect(manifest.sides[0].files["query.ts"]).toContain(".leftJoin(");
    expect(manifest.sides[1].files["query.ts"]).toContain("db.query.users.findMany");
  });

  it("should list only the topics in use, in the fixed order", () => {
    const topics = listExampleTopics();

    expect(topics[0]).toBe("Queries");
    expect(new Set(topics).size).toBe(topics.length);
  });
});

describe("parseExample", () => {
  it("should build a manifest with the pair", () => {
    const example = parseExample(makeSource());
    const manifest = getOneVersionManifest(example);

    expect(manifest.dependencies).toEqual({ "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" });
    expect(manifest.entrypoints).toEqual({ schema: "schema.ts", seed: "seed.ts", run: "query.ts" });
  });

  it("should run an example on the guest flavor it names", () => {
    const example = parseExample(
      makeSource({ dialect: "postgresql", releasePair: "orm-1.0.0-rc.5__kit-1.0.0-rc.5", guestFlavor: "effect" }),
    );

    expect(getOneVersionManifest(example).guestFlavor).toBe("effect");
  });

  it("should leave out the seed entrypoint when there is no seed file", () => {
    const { "seed.ts": _seed, ...withoutSeed } = files;

    expect(parseExample({ ...makeSource(), files: withoutSeed }).manifest.entrypoints).toEqual({
      schema: "schema.ts",
      run: "query.ts",
    });
  });

  it.each([
    [{ topic: "Cooking" }, /topic/],
    [{ featured: "yes" }, /featured/],
    [{ dialect: "mysql" }, /dialect/],
    [{ releasePair: "0.45.4" }, /releasePair/],
    [{ releasePair: "orm-9.9.9__kit-9.9.9" }, /Example "sample"/],
    [{ dependencies: { zod: "4.4.3" } }, /unknown fields: dependencies/],
    [{ extra: true }, /unknown fields: extra/],
    [{ title: "" }, /title/],
    [{ id: "sample" }, /id must be a lowercase UUID/],
    [{ id: "EE9BF870-CA60-4975-A7E3-F9E12000CB40" }, /id must be a lowercase UUID/],
    [{ slug: "two words" }, /slug must be/],
    [{ slug: ".." }, /slug must be/],
    [{ status: "hidden" }, /status must be published, draft, or deleted/],
    [{ guestFlavor: "heavy" }, /guestFlavor must be slim or effect/],
    [{ guestFlavor: "effect" }, /Example "sample"/],
  ])("should reject %j", (metadata, message) => {
    expect(() => parseExample(makeSource(metadata))).toThrow(message);
  });

  it("should reject a folder name that is not a slug", () => {
    expect(() => parseExample(makeSource({}, "Bad Name"))).toThrow(/folder name/);
  });

  it("should require schema.ts and query.ts", () => {
    const { "query.ts": _query, ...withoutQuery } = files;

    expect(() => parseExample({ ...makeSource(), files: withoutQuery })).toThrow(/query\.ts is required/);
  });

  it("should accept docs and notes links on their origins only", () => {
    const example = parseExample(
      makeSource({
        links: [
          { kind: "docs", label: "Select", url: "https://orm.drizzle.team/docs/select" },
          { kind: "notes", label: "Note", url: "https://notes.drizzle.run/relations" },
        ],
      }),
    );

    expect(example.links.map((link) => link.kind)).toEqual(["docs", "notes"]);
    expect(() =>
      parseExample(makeSource({ links: [{ kind: "docs", label: "Elsewhere", url: "https://example.com/docs" }] })),
    ).toThrow(/orm\.drizzle\.team/);
    expect(() =>
      parseExample(makeSource({ links: [{ kind: "notes", label: "Docs", url: "https://orm.drizzle.team/docs" }] })),
    ).toThrow(/notes\.drizzle\.run/);
    expect(() =>
      parseExample(makeSource({ links: [{ kind: "video", label: "Watch", url: "https://orm.drizzle.team" }] })),
    ).toThrow(/unknown kind/);
  });
});

describe("parseExample side by side", () => {
  it("should share files/ and run sides/ per side, each named, on the example's pair", () => {
    const { manifest } = parseExample(makeSideBySideSource());

    if (!isPairManifest(manifest)) {
      throw new Error("Expected a side-by-side manifest.");
    }

    expect(Object.keys(manifest.files).toSorted()).toEqual(["schema.ts", "seed.ts"]);
    expect(manifest.entrypoints).toEqual({ schema: "schema.ts", seed: "seed.ts", run: "query.ts" });
    expect(manifest.sides.map((side) => side.name)).toEqual(["Classic", "RQB"]);
    expect(manifest.sides.map((side) => side.dependencies)).toEqual([
      { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
      { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
    ]);
    expect(manifest.sides[1].files["query.ts"]).toBe("export const other = 1;\n");
  });

  it.each([
    [{ sides: [{ name: "Classic" }] }, /sides must list two sides/],
    [{ sides: [{ name: "Classic" }, {}] }, /sides must list two sides/],
    [{ sides: [{ name: "Classic" }, { name: "RQB", releasePair: "0.45.4" }] }, /sides must list/],
    [{ sides: [{ name: "Classic" }, { name: "RQB", runtime: "pglite" }] }, /sides must list/],
    [{ sides: [{ name: "Classic" }, { name: "" }] }, /Example "sample"/],
  ])("should reject sides %j", (metadata, message) => {
    expect(() => parseExample(makeSideBySideSource(metadata))).toThrow(message);
  });

  it("should run each side on its own database, pair and flavor, with no example-wide default", () => {
    const postgresSchema =
      'import { pgTable, integer } from "drizzle-orm/pg-core";\n\nexport const items = pgTable("items", { id: integer("id").primaryKey() });\n';
    const { "schema.ts": sqliteSchema, ...shared } = files;
    const { manifest } = parseExample({
      ...makeSource({
        dialect: undefined,
        releasePair: undefined,
        sides: [
          { name: "Legacy on Postgres", dialect: "postgresql", releasePair: "orm-0.45.4__kit-0.31.11" },
          {
            name: "Effect on SQLite",
            dialect: "sqlite",
            releasePair: "orm-1.0.0-rc.5__kit-1.0.0-rc.5",
            guestFlavor: "effect",
          },
        ],
      }),
      files: pick(shared, ["seed.ts"]),
      sideFiles: [
        { "schema.ts": postgresSchema, "query.ts": "export {};\n" },
        { "schema.ts": sqliteSchema, "query.ts": "export {};\n" },
      ],
    });

    if (!isPairManifest(manifest)) {
      throw new Error("Expected a side-by-side manifest.");
    }

    expect(
      manifest.sides.map((side) => [side.target.dialect, side.dependencies["drizzle-orm"], side.guestFlavor]),
    ).toEqual([
      ["postgresql", "0.45.4", undefined],
      ["sqlite", "1.0.0-rc.5", "effect"],
    ]);
  });

  it("should name the side that has no database or pair", () => {
    expect(() =>
      parseExample(
        makeSideBySideSource({ dialect: undefined, sides: [{ name: "A", dialect: "sqlite" }, { name: "B" }] }),
      ),
    ).toThrow(/side "B" name no dialect/);
    expect(() =>
      parseExample(
        makeSideBySideSource({
          releasePair: undefined,
          sides: [{ name: "A" }, { name: "B", releasePair: "orm-0.45.4__kit-0.31.11" }],
        }),
      ),
    ).toThrow(/side "A" name no releasePair/);
  });

  it("should refuse side files without sides, a seed per side, or a query on one side only", () => {
    const source = makeSideBySideSource();
    const [first, second] = source.sideFiles ?? [{}, {}];

    expect(() => parseExample({ ...makeSource(), sideFiles: source.sideFiles })).toThrow(/must list its sides/);
    expect(() => parseExample({ ...source, sideFiles: [{ ...first, "seed.ts": "export {};\n" }, second] })).toThrow(
      /seed\.ts is the seed file both sides share/,
    );
    expect(() => parseExample({ ...source, sideFiles: [first, {}] })).toThrow(/query\.ts is required/);
  });

  it("should name each side on the gallery card, and nothing for one version", () => {
    expect(resolveExampleSides(parseExample(makeSideBySideSource()))).toEqual([
      { name: "Classic", ormVersion: "0.45.4" },
      { name: "RQB", ormVersion: "0.45.4" },
    ]);
    expect(resolveExampleSides(parseExample(makeSource()))).toBeNull();
  });
});

describe("loadExamples", () => {
  it("should reject an example link to a missing example", () => {
    const linked = makeSource({ links: [{ kind: "example", label: "Next", slug: "nowhere" }] });

    expect(() => loadExamples([linked])).toThrow(/"nowhere", which does not exist/);
    expect(loadExamples([linked, makeSource({ id: "00000000-0000-4000-8000-000000000002" }, "nowhere")])).toHaveLength(
      2,
    );
  });

  it("should keep every version of a slug, and refuse two published ones", () => {
    const published = makeSource({}, "sample");
    const draft = makeSource({ id: "00000000-0000-4000-8000-000000000002", slug: "sample", status: "draft" }, "next");
    const deleted = makeSource(
      { id: "00000000-0000-4000-8000-000000000003", slug: "sample", status: "deleted" },
      "old",
    );
    const second = makeSource({ id: "00000000-0000-4000-8000-000000000004", slug: "sample" }, "other");

    expect(loadExamples([published, draft, deleted]).map((example) => example.folder)).toEqual([
      "sample",
      "next",
      "old",
    ]);
    expect(() => loadExamples([published, second])).toThrow(/one published version of the example "sample"/);
    expect(() => loadExamples([published, makeSource({}, "copy")])).toThrow(/own id/);
  });

  it("should check links against live versions only", () => {
    const linked = makeSource({ links: [{ kind: "example", label: "Gone", slug: "gone" }] });
    const gone = makeSource({ id: "00000000-0000-4000-8000-000000000002", status: "deleted" }, "gone");

    expect(() => loadExamples([linked, gone])).toThrow(/"gone", which does not exist/);
  });
});

const GUIDE_ID = "00000000-0000-4000-8000-0000000000a1";

function makeGuide(
  project: GuideManifest["project"],
  options: Partial<Pick<GuideVersion, "id" | "slug" | "status" | "example" | "folder">> = {},
): GuideVersion {
  const transactions = listGuideVersions().find((version) => version.id === "db0755a7-fec9-4789-a9f7-d9314d0083cc");

  if (transactions === undefined) {
    throw new Error("Expected the transactions guide.");
  }

  const id = options.id ?? GUIDE_ID;

  return {
    id,
    slug: options.slug ?? "sample",
    status: options.status ?? "published",
    folder: options.folder ?? "sample",
    example: options.example ?? SAMPLE_ID,
    manifest: { ...transactions.manifest, id, project },
  };
}

describe("guided examples", () => {
  it("should attach the guide that walks the example version", () => {
    const manifest = getOneVersionManifest(parseExample(makeSource()));
    const [loaded] = loadExamples([makeSource()], [makeGuide(manifest)]);

    expect(loaded.guide?.id).toBe(GUIDE_ID);
    expect(loaded.guideFolder).toBe("sample");
    expect(getExampleKind(loaded)).toBe("guided");
  });

  it("should attach a draft guide only when drafts show", () => {
    const manifest = getOneVersionManifest(parseExample(makeSource()));
    const published = makeGuide(manifest);
    const draft = makeGuide(manifest, {
      id: "00000000-0000-4000-8000-0000000000a2",
      status: "draft",
      folder: "sample-next",
    });

    expect(loadExamples([makeSource()], [published, draft], false)[0]?.guide?.id).toBe(GUIDE_ID);
    expect(loadExamples([makeSource()], [published, draft], true)[0]?.guideFolder).toBe("sample-next");
  });

  it("should refuse a guide of a missing example, under another slug, or published over a draft", () => {
    const manifest = getOneVersionManifest(parseExample(makeSource()));
    const draftSource = makeSource({ status: "draft" });

    expect(() =>
      loadExamples([makeSource()], [makeGuide(manifest, { example: "00000000-0000-4000-8000-00000000ffff" })]),
    ).toThrow(/which does not exist/);
    expect(() => loadExamples([makeSource()], [makeGuide(manifest, { slug: "other" })])).toThrow(
      /must have the example's slug "sample"/,
    );
    expect(() => loadExamples([draftSource], [makeGuide(manifest)])).toThrow(/must be too/);
  });

  it("should refuse a guide that starts from other files or another pair", () => {
    const manifest = getOneVersionManifest(parseExample(makeSource()));

    expect(() =>
      loadExamples([makeSource()], [makeGuide({ ...manifest, files: { ...manifest.files, "query.ts": "other" } })]),
    ).toThrow(/must start from the example's files/);
  });

  it("should attach a side-by-side guide when one side runs the example's pair and files", () => {
    const manifest = getOneVersionManifest(parseExample(makeSource()));
    const target = { dialect: "sqlite" } as const;
    const tuples = [
      resolveSupportedTuple({ target, ormVersion: "0.45.4", kitVersion: "0.31.11" }),
      resolveSupportedTuple({ target, ormVersion: "1.0.0-rc.5", kitVersion: "1.0.0-rc.5" }),
    ] as const;
    const [loaded] = loadExamples([makeSource()], [makeGuide(createPairManifest(manifest, tuples, "separate"))]);

    expect(loaded.guide?.id).toBe(GUIDE_ID);
    const otherFiles = createPairManifest(
      { ...manifest, files: { ...manifest.files, "query.ts": "other" } },
      tuples,
      "separate",
    );

    expect(() => loadExamples([makeSource()], [makeGuide(otherFiles)])).toThrow(/must start from the example's files/);
  });
});

describe("collectSources", () => {
  it("should group glob results by folder and keep nested file paths", () => {
    const sources = collectSources({
      metadata: { "../../examples/a/example.json": { title: "A" } },
      files: { "../../examples/a/files/query.ts": "q", "../../examples/a/files/lib/util.ts": "u" },
    });

    expect(sources).toEqual([
      { folder: "a", metadata: { title: "A" }, files: { "query.ts": "q", "lib/util.ts": "u" } },
    ]);
  });

  it("should keep each side's files of a side-by-side example apart", () => {
    const [source] = collectSources({
      metadata: { "../../examples/a/example.json": { title: "A" } },
      files: {
        "../../examples/a/files/schema.ts": "s",
        "../../examples/a/sides/1/query.ts": "classic",
        "../../examples/a/sides/2/query.ts": "rqb",
      },
    });

    expect(source?.files).toEqual({ "schema.ts": "s" });
    expect(source?.sideFiles).toEqual([{ "query.ts": "classic" }, { "query.ts": "rqb" }]);
  });
});
