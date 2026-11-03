import { parseGuideManifest, resolveStep, type GuideManifest } from "@drizzle-run/core/guide";
import { describe, expect, it } from "vitest";

import { findExample } from "../examples/catalog";
import {
  findGuide,
  FIRST_RUN_GUIDES,
  getGuideProgressSetting,
  listGuideVersions,
  loadGuides,
  readGuideMark,
  readStepMeta,
} from "./catalog";

const sources = import.meta.glob<{ guide: unknown }>("../../guides/*/guide.ts");
const compiled = import.meta.glob<unknown>("../../guides/*/guide.json", { eager: true, import: "default" });

function getGuide(slug: string) {
  const found = findGuide(slug);

  if (!found) {
    throw new Error(`Missing guide ${slug}`);
  }

  return found;
}

function withFirstStepMeta(manifest: GuideManifest, meta: Record<string, unknown> | undefined): GuideManifest {
  return {
    ...manifest,
    steps: manifest.steps.map((step, index) => (index === 0 ? { ...step, meta } : step)),
  };
}

describe("guide catalog", () => {
  it("should parse every guide version, one per folder, sorted by slug", () => {
    expect(listGuideVersions().map(({ slug, status }) => `${slug} ${status}`)).toEqual([
      "drizzle-in-five-minutes published",
      "drizzle-with-effect published",
      "first-run published",
      "first-run-sqlite published",
      "joins-explained published",
      "nested-sql-results published",
      "prepared-queries published",
      "relational-queries published",
      "select-vs-relational-queries published",
      "subqueries published",
      "transactions published",
    ]);
    expect(Object.keys(sources)).toHaveLength(listGuideVersions().length);
  });

  it("should find a guide by its slug, never by its id", () => {
    const transactions = getGuide("transactions");

    expect(transactions.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(findGuide(transactions.id)).toBeUndefined();
  });

  it("should keep each guide.json in sync with its guide.ts", async () => {
    for (const [path, load] of Object.entries(sources)) {
      const source = await load();

      expect(compiled[path.replace(/\.ts$/, ".json")], path).toEqual(
        JSON.parse(JSON.stringify(parseGuideManifest(source.guide))),
      );
    }
  });

  it("should refuse a guide without its version fields, and two versions with one id", () => {
    const firstRun = compiled["../../guides/first-run/guide.json"] as GuideManifest;

    expect(() => loadGuides({ "../../guides/a/guide.json": { ...firstRun, id: "first-run" } })).toThrow(
      "guides/a: id must be a lowercase UUID",
    );
    expect(() =>
      loadGuides({ "../../guides/a/guide.json": { ...firstRun, meta: { ...firstRun.meta, status: "hidden" } } }),
    ).toThrow("guides/a: meta.status must be published, draft, or deleted.");
    expect(() => loadGuides({ "../../guides/a/guide.json": firstRun, "../../guides/b/guide.json": firstRun })).toThrow(
      /own id/,
    );
  });

  it("should start each guide from the project of the example it walks", () => {
    expect(getGuide("drizzle-in-five-minutes").project).toEqual(findExample("drizzle-in-five-minutes")?.manifest);
    expect(getGuide("transactions").project).toEqual(findExample("transactions")?.manifest);
    expect(getGuide("joins-explained").project).toEqual(findExample("joins-explained")?.manifest);
    expect(getGuide("nested-sql-results").project).toEqual(findExample("nested-sql-results")?.manifest);
    expect(getGuide("prepared-queries").project).toEqual(findExample("prepared-queries")?.manifest);
    expect(getGuide("subqueries").project).toEqual(findExample("subqueries")?.manifest);
    expect(getGuide("select-vs-relational-queries").project).toEqual(
      findExample("select-vs-relational-queries")?.manifest,
    );
    expect(getGuide("first-run").project).toEqual(findExample("quick-start-postgresql")?.manifest);
    expect(getGuide("first-run-sqlite").project).toEqual(findExample("quick-start-sqlite")?.manifest);
  });

  it("should open a three-step first run for each starter dialect", () => {
    for (const id of Object.values(FIRST_RUN_GUIDES)) {
      const manifest = getGuide(id);

      expect(manifest.title).toBe("First run");
      expect(manifest.steps.map(({ title }) => title)).toEqual([
        "The three project files",
        "Run the project",
        "Filter the users",
      ]);
    }
  });

  it("should give every step a summary and keep every edit applicable", () => {
    for (const { manifest } of listGuideVersions()) {
      for (const [index, step] of manifest.steps.entries()) {
        expect(readStepMeta(manifest, step).summary.length, `${manifest.id} ${step.id}`).toBeGreaterThan(0);
        expect(() => resolveStep(manifest, index), `${manifest.id} ${step.id}`).not.toThrow();
      }
    }
  });

  it("should keep progress apart for a guided example and each guided project", () => {
    expect(getGuideProgressSetting("transactions")).toBe("guide:transactions");
    expect(getGuideProgressSetting("first-run", "p1")).toBe("guide:first-run:p1");
  });
});

describe("guide meta", () => {
  it("should read a step's summary and what changed as rich text", () => {
    const copy = readStepMeta(getGuide("transactions"), getGuide("transactions").steps[1]);

    expect(copy.summary[0]?.length).toBeGreaterThan(0);
    expect(copy.changed?.flat().some((inline) => inline.kind === "bold" && inline.text === "released")).toBe(true);
  });

  it("should refuse a step without a summary, or with meta that is not text", () => {
    const manifest = getGuide("first-run");

    expect(() => readStepMeta(manifest, withFirstStepMeta(manifest, undefined).steps[0])).toThrow(
      'step "01-files" needs meta.summary',
    );
    expect(() => readStepMeta(manifest, withFirstStepMeta(manifest, { summary: "Hi", changed: 3 }).steps[0])).toThrow(
      "meta.changed must be text",
    );
  });

  it("should split the title around its marked words", () => {
    expect(readGuideMark(getGuide("transactions"))).toEqual({
      before: "Transactions keep ",
      mark: "all or nothing",
      after: "",
    });
    expect(readGuideMark({ ...getGuide("transactions"), meta: undefined })).toEqual({
      before: "Transactions keep all or nothing",
      mark: "",
      after: "",
    });
    expect(() => readGuideMark({ ...getGuide("transactions"), meta: { mark: "rollback" } })).toThrow(
      "meta.mark must be words of its title",
    );
  });
});
