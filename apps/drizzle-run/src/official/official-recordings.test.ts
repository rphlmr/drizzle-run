import { serializeValue } from "@drizzle-run/core/contracts";
import { describe, expect, it } from "vitest";

import { listExamples } from "../examples/catalog";
import {
  checkOfficialRecording,
  listOfficialEmbeds,
  listOfficialGuests,
  resolveOfficialEmbed,
  type OfficialEmbed,
  type OfficialRecordingCheck,
} from "./official-embeds";
import { loadOfficialRecording } from "./official-recordings";

const committedRecordings = import.meta.glob<unknown>(
  ["../../examples/*/recording.json", "../../guides/*/recordings/*.json"],
  { eager: true, import: "default" },
);
const officialEmbeds = listOfficialEmbeds(listExamples());
const refreshHint = "Run `pnpm record:official` to record the official embeds again.";

async function getRecordedDisplays({ example, step }: { example: string; step?: string }) {
  const embed = resolveOfficialEmbed(listExamples(), { example, ...(step === undefined ? {} : { step }) });

  if (!embed) {
    throw new Error(`Missing official embed: ${example}/${step ?? "example"}`);
  }

  const recording = await loadOfficialRecording(embed);

  if (!recording?.result) {
    throw new Error(`Missing current single-project recording: ${embed.recordingPath}`);
  }

  return Object.fromEntries(recording.result.displays.map(({ label, values }) => [label, values]));
}

describe("advanced teaching results", () => {
  it("should reuse prepared placeholders for filters and limits and report a missing value", async () => {
    const bound = await getRecordedDisplays({ example: "prepared-queries", step: "01-bound-values" });
    const prepared = await getRecordedDisplays({ example: "prepared-queries", step: "02-prepare" });
    const missing = await getRecordedDisplays({ example: "prepared-queries", step: "04-missing-value" });
    const starter = await getRecordedDisplays({ example: "prepared-product-search" });
    const pocket = { id: 2, name: "Pocket notes", category: "books", priceCents: 800 };
    const notebook = { id: 3, name: "Query notebook", category: "books", priceCents: 1200 };
    const handbook = { id: 1, name: "SQL handbook", category: "books", priceCents: 2500 };
    const tool = { id: 4, name: "Debugging kit", category: "tools", priceCents: 4500 };

    expect(bound.Books).toEqual([serializeValue([pocket, notebook, handbook])]);
    expect(prepared.Books).toEqual(bound.Books);
    expect(prepared.Tools).toEqual([serializeValue([tool])]);
    expect(starter["First book at or above 1000 cents"]).toEqual([serializeValue([notebook])]);
    expect(starter["Two books at or above 1000 cents"]).toEqual([serializeValue([notebook, handbook])]);
    expect(starter["Tools under the same query shape"]).toEqual([serializeValue([tool])]);
    expect(missing["Missing placeholder"]).toEqual([
      serializeValue('No value for placeholder "minimumCents" was provided'),
    ]);
  });

  it("should compose membership, existence, scalar and grouped subqueries without losing empty authors", async () => {
    const membership = await getRecordedDisplays({ example: "subqueries", step: "01-membership" });
    const existence = await getRecordedDisplays({ example: "subqueries", step: "02-exists" });
    const grouped = await getRecordedDisplays({ example: "subqueries", step: "03-derived-table" });
    const scalar = await getRecordedDisplays({ example: "subqueries", step: "04-scalar" });
    const cte = await getRecordedDisplays({ example: "subqueries", step: "05-cte" });
    const starter = await getRecordedDisplays({ example: "author-report" });
    const report = [
      { name: "Ada", publishedPosts: 2, views: 40 },
      { name: "Grace", publishedPosts: 1, views: 5 },
      { name: "Linus", publishedPosts: 0, views: 0 },
    ];

    expect(membership["Authors with published posts"]).toEqual([serializeValue([{ name: "Ada" }, { name: "Grace" }])]);
    expect(existence["Authors with published posts"]).toEqual(membership["Authors with published posts"]);
    expect(existence["Authors without published posts"]).toEqual([serializeValue([{ name: "Linus" }])]);
    expect(grouped["Author report"]).toEqual([serializeValue(report)]);
    expect(cte["Author report"]).toEqual(grouped["Author report"]);
    expect(starter["Author report"]).toEqual(grouped["Author report"]);
    expect(starter["Authors with at least 30 published views"]).toEqual([serializeValue([report[0]])]);
    expect(scalar["One count per author"]).toEqual([
      serializeValue(report.map(({ name, publishedPosts }) => ({ name, publishedPosts }))),
    ]);
  });

  it("should preserve nullable comments, empty collections and all tags when filtering a file", async () => {
    const starter = await getRecordedDisplays({ example: "files-with-comments-and-tags" });
    const guide = await getRecordedDisplays({ example: "nested-sql-results", step: "06-rqb" });
    const launch = {
      id: 1,
      name: "Launch notes",
      comments: [
        { id: 1, text: "Ready to review", author: { id: 1, name: "Ada" } },
        { id: 2, text: null, author: { id: 2, name: "Grace" } },
      ],
      tags: [
        { id: 1, name: "release" },
        { id: 2, name: "review" },
        { id: 3, name: "team" },
      ],
    };
    const expected = [
      serializeValue([
        launch,
        { id: 2, name: "Empty draft", comments: [], tags: [] },
        {
          id: 3,
          name: "Design sketch",
          comments: [{ id: 3, text: "Keep this version", author: { id: 1, name: "Ada" } }],
          tags: [{ id: 2, name: "review" }],
        },
      ]),
    ];

    expect(starter["Files with comments and tags"]).toEqual(expected);
    expect(starter["Files tagged release, with all their tags"]).toEqual([serializeValue([launch])]);
    expect(guide["Files with comments and tags"]).toEqual(expected);
    expect(guide["The same files with RQB"]).toEqual(expected);
  });

  it("should filter JSONB attributes and distinguish a missing color from JSON null", async () => {
    const displays = await getRecordedDisplays({ example: "jsonb-product-filters" });

    expect(displays["Blue products available in M"]).toEqual([
      serializeValue([
        {
          id: 1,
          name: "Blue shirt",
          attributes: { color: "blue", sizes: ["S", "M"], shipping: { weightGrams: 200 } },
        },
      ]),
    ]);
    expect(displays["Products under 300 grams"]).toEqual([
      serializeValue([{ name: "Blue shirt" }, { name: "Red shirt" }]),
    ]);
    expect(displays["Missing color versus JSON null"]).toEqual([
      serializeValue([
        { name: "Blue shirt", hasColor: true, colorIsJsonNull: false, colorText: "blue" },
        { name: "Blue coat", hasColor: true, colorIsJsonNull: false, colorText: "blue" },
        { name: "Red shirt", hasColor: true, colorIsJsonNull: false, colorText: "red" },
        { name: "Gift card", hasColor: false, colorIsJsonNull: false, colorText: null },
        { name: "Uncoloured sample", hasColor: true, colorIsJsonNull: true, colorText: null },
      ]),
    ]);
  });

  it("should update JSONB siblings in place and explicitly create a missing parent", async () => {
    const displays = await getRecordedDisplays({ example: "jsonb-preference-updates" });

    expect(displays["Linus still has no notifications object"]).toEqual([
      serializeValue([{ id: 3, name: "Linus", preferences: { theme: "dark" } }]),
    ]);
    expect(displays["After, including unchanged Grace"]).toEqual([
      serializeValue([
        { id: 1, name: "Ada", preferences: { theme: "dark", notifications: { email: false, sms: true } } },
        { id: 2, name: "Grace", preferences: { theme: "light", notifications: {} } },
        { id: 3, name: "Linus", preferences: { theme: "dark", notifications: { email: false } } },
      ]),
    ]);
  });

  it("should show which unmatched rows each join and filter preserves", async () => {
    const inner = await getRecordedDisplays({ example: "joins-explained", step: "01-inner" });
    const left = await getRecordedDisplays({ example: "joins-explained", step: "02-left" });
    const where = await getRecordedDisplays({ example: "joins-explained", step: "03-where" });
    const on = await getRecordedDisplays({ example: "joins-explained", step: "04-on" });
    const outer = await getRecordedDisplays({ example: "joins-explained", step: "05-outer" });
    const cross = await getRecordedDisplays({ example: "joins-explained", step: "06-cross" });
    const matched = [
      { author: "Ada", title: "Types in practice" },
      { author: "Ada", title: "Draft notes" },
      { author: "Grace", title: "Compilers" },
    ];

    expect(inner["Matching authors and books"]).toEqual([serializeValue(matched)]);
    expect(left["Every author"]).toEqual([serializeValue([...matched, { author: "Linus", title: null }])]);
    expect(where["Published books, filtered after the join"]).toEqual([serializeValue([matched[0]])]);
    expect(on["Every author, with published books"]).toEqual([
      serializeValue([matched[0], { author: "Grace", title: null }, { author: "Linus", title: null }]),
    ]);
    expect(outer["Right join keeps every book"]).toEqual([
      serializeValue([...matched, { author: null, title: "Anonymous tale" }]),
    ]);
    expect(outer["Full join keeps both sides"]).toEqual([
      serializeValue([...matched, { author: "Linus", title: null }, { author: null, title: "Anonymous tale" }]),
    ]);
    expect(cross["Every possible author and book pair"]).toEqual([
      serializeValue(
        ["Ada", "Grace", "Linus"].flatMap((author) =>
          ["Types in practice", "Draft notes", "Compilers", "Anonymous tale"].map((title) => ({ author, title })),
        ),
      ),
    ]);
  });
});

describe("listOfficialEmbeds", () => {
  it("should list each example, then each step of its guide that runs", () => {
    const transactions = officialEmbeds.filter((embed) => embed.example.slug === "transactions");

    expect(transactions.map((embed) => embed.recordingPath)).toEqual([
      "examples/transactions/recording.json",
      "guides/transactions/recordings/01-as-written.json",
      "guides/transactions/recordings/02-savepoint.json",
      "guides/transactions/recordings/03-overdraft.json",
    ]);
    expect(transactions.map((embed) => embed.step?.index)).toEqual([undefined, 0, 1, 2]);
  });

  it("should open a side-by-side guide's steps on both sides", () => {
    const step = resolveOfficialEmbed(listExamples(), { example: "relational-queries", step: "01-relations" });

    expect(step?.manifest.kind).toBe("drizzle-run-pair");
  });
});

describe("resolveOfficialEmbed", () => {
  it("should return null for an unknown example or step", () => {
    expect(resolveOfficialEmbed(listExamples(), { example: "missing" })).toBeNull();
    expect(resolveOfficialEmbed(listExamples(), { example: "transactions", step: "99-missing" })).toBeNull();
    expect(resolveOfficialEmbed(listExamples(), { example: "quick-start-sqlite", step: "01-files" })).toBeNull();
  });
});

/** The problem a committed recording has, named by its embed; `null` when it is valid. */
function describeProblem(embed: OfficialEmbed, checked: OfficialRecordingCheck): string | null {
  switch (checked.status) {
    case "valid":
      return null;

    case "invalid":
      return `${embed.recordingPath} is not a valid recording.`;

    case "other_code":
      return `${embed.recordingPath} was recorded for other code.`;

    case "older_guest":
      return `${embed.recordingPath} was recorded on an older ${checked.guest.imageId} guest. Run \`pnpm record:official\`.`;
  }
}

describe("official recordings", () => {
  it("should have a recording for exactly the code and guests of every official embed", () => {
    const problems = officialEmbeds.flatMap((embed) => {
      const recording = committedRecordings[`../../${embed.recordingPath}`];

      if (recording === undefined) {
        return [`${embed.recordingPath} is missing.`];
      }

      return describeProblem(embed, checkOfficialRecording(embed, recording)) ?? [];
    });

    expect(problems, refreshHint).toEqual([]);
  });

  it("should flag a recording made on a guest whose lock the catalog has since refreshed", () => {
    const embed = officialEmbeds.find(
      (candidate) => candidate.recordingPath === "examples/quick-start-sqlite/recording.json",
    );
    const recording = committedRecordings["../../examples/quick-start-sqlite/recording.json"];

    if (embed === undefined || typeof recording !== "object" || recording === null) {
      throw new Error("Expected the quick-start-sqlite example to have a committed recording.");
    }

    const [currentGuest] = listOfficialGuests(embed.manifest);
    const olderGuest = { imageId: currentGuest?.imageId, lockDigest: `sha256-${"0".repeat(64)}` };

    const checked = checkOfficialRecording(embed, { ...recording, guests: [olderGuest] });

    expect(checkOfficialRecording(embed, recording).status).toBe("valid");
    expect(checked).toEqual({ status: "older_guest", guest: olderGuest });
    expect(describeProblem(embed, checked)).toBe(
      `examples/quick-start-sqlite/recording.json was recorded on an older ${currentGuest?.imageId} guest. ` +
        "Run `pnpm record:official`.",
    );
  });

  it("should keep no recording that no official embed opens", () => {
    const used = new Set(officialEmbeds.map((embed) => `../../${embed.recordingPath}`));

    expect(
      Object.keys(committedRecordings).filter((path) => !used.has(path)),
      refreshHint,
    ).toEqual([]);
  });

  it("should load a recording only for the code it ran", async () => {
    const example = officialEmbeds.find(
      (embed) => embed.recordingPath === "examples/quick-start-sqlite/recording.json",
    );

    if (example === undefined || example.manifest.kind !== "drizzle-run") {
      throw new Error("Expected the quick-start-sqlite example to be a one-version official embed.");
    }

    const edited = {
      ...example,
      manifest: { ...example.manifest, files: { ...example.manifest.files, "query.ts": "// edited\n" } },
    };

    expect((await loadOfficialRecording(example))?.result?.outcome).toBe("succeeded");
    expect(await loadOfficialRecording(edited)).toBeNull();
  });
});
