import { describe, expect, it } from "vitest";

import {
  createD1DocumentServices,
  resolveDocumentMeta,
  type DocumentRoute,
  type DocumentServices,
} from "../worker/document-meta.ts";
import { exampleSummaries } from "../worker/examples.generated.ts";
import type { WorkerEnvironment } from "../worker/platform.ts";
import type { SnapshotPair, SnapshotSummaryJson } from "../worker/snapshot-summary.ts";
import { listOgImages, toReleaseLabel } from "./cards.ts";

/** A side's database and pair, on the slim guest. */
function makePair(dialect: "postgresql" | "sqlite", orm: string, kit = "1.0.0-rc.5"): SnapshotPair {
  return { dialect, orm, kit, guestFlavor: "slim" };
}

/** A stored snapshot summary for a one-version share, or a side by side with two pairs. */
function makeSummaryJson(pairs: SnapshotSummaryJson["pairs"]): string {
  const summary: SnapshotSummaryJson = {
    name: "Share",
    pairs,
    files: {},
  };

  return JSON.stringify(summary);
}

describe("listOgImages", () => {
  it("should draw every image the Worker's pages name", async () => {
    const drawn = new Set(listOgImages(exampleSummaries).map((image) => `/${image.path}`));
    const environment = {} as WorkerEnvironment;
    const linkId = "123e4567-e89b-42d3-a456-426614174000";
    const routes: DocumentRoute[] = [
      { kind: "home" },
      { kind: "examples" },
      { kind: "community" },
      { kind: "private", path: "/p/local" },
      ...exampleSummaries.map((example) => ({ kind: "example" as const, slug: example.slug })),
    ];
    const named: string[] = [];

    for (const route of routes) {
      named.push((await resolveDocumentMeta(route, environment, createD1DocumentServices())).image.path);
    }

    const summaries = [
      makeSummaryJson([makePair("sqlite", "0.45.4", "0.31.11")]),
      makeSummaryJson([makePair("postgresql", "1.0.0-rc.5"), makePair("postgresql", "0.45.4")]),
      makeSummaryJson([makePair("sqlite", "1.0.0-rc.5"), makePair("postgresql", "1.0.0-rc.5")]),
      makeSummaryJson([makePair("postgresql", "0.44.0", "0.30.0")]),
    ];

    for (const [listingTopic, summaryJson] of [null, "playground", "bug-repros"].flatMap((topic) =>
      summaries.map((entry) => [topic as "playground" | "bug-repros" | null, entry] as const),
    )) {
      const services: DocumentServices = {
        sharePages: () => ({
          findSharePage: async () => ({
            summaryJson,
            description: null,
            listingTopic,
          }),
          listListedLinkIds: async () => [],
        }),
      };

      named.push((await resolveDocumentMeta({ kind: "share", linkId }, environment, services)).image.path);
    }

    expect(named.filter((path) => !drawn.has(path))).toEqual([]);
    expect(named).toEqual(
      expect.arrayContaining([
        "/og/shares/bug-repros/postgresql/0.45.4-vs-1.0.0-rc.5.png",
        "/og/shares/playground/postgresql-vs-sqlite/1.0.0-rc.5-vs-1.0.0-rc.5.png",
        "/og/shares/playground.png",
      ]),
    );
  });
});

describe("toReleaseLabel", () => {
  it("should name versions as the app does", () => {
    expect(toReleaseLabel("0.45.4")).toBe("Legacy");
    expect(toReleaseLabel("1.0.0-rc.5")).toBe("RC");
    expect(toReleaseLabel("1.0.0")).toBe("Latest");
  });
});
