import { describe, expect, it } from "vitest";

import type { OgCard } from "./cards.ts";
import { layoutOgCard, type OgElement } from "./layout.ts";
import { createOgRenderer } from "./render.ts";

const renderer = await createOgRenderer();

const exampleCard: OgCard = {
  kind: "example",
  title: "Drizzle in five minutes",
  description: "Tables, a relation, seed data, and a join, one step at a time.",
  runtime: { sides: [{ dialect: "postgresql", ormVersion: "1.0.0-rc.5", guestFlavor: "slim" }] },
};

/** The widest footer: sides on two databases, each naming its own, with the Effect flavor. */
const crossDatabaseShare: OgCard = {
  kind: "share",
  topic: "bug-repros",
  runtime: {
    sides: [
      { dialect: "postgresql", ormVersion: "1.0.0-rc.5", guestFlavor: "effect" },
      { dialect: "sqlite", ormVersion: "1.0.0-rc.5", guestFlavor: "effect" },
    ],
  },
};

/** Every text the element tree draws, in order. */
function listTexts(node: OgElement): string[] {
  return [node.props.children ?? []]
    .flat()
    .flatMap((child) => (typeof child === "string" ? [child] : listTexts(child)));
}

/** The text of every element drawn on `color`. */
function listTextsOn(node: OgElement, color: string): string[] {
  const own = node.props.style?.backgroundColor === color ? [listTexts(node).join("")] : [];
  const children = [node.props.children ?? []].flat().filter((child) => typeof child !== "string");

  return [...own, ...children.flatMap((child) => listTextsOn(child, color))];
}

describe("layoutOgCard", () => {
  it("should draw every card kind at 1200 x 630 with the app's fonts", async () => {
    const cards: OgCard[] = [
      { kind: "page", title: "Community shares", description: "Playgrounds people shared." },
      exampleCard,
      { ...exampleCard, title: "x".repeat(200) },
      { kind: "share", topic: "playground", runtime: null },
      {
        kind: "share",
        topic: "bug-repros",
        runtime: {
          sides: [
            { dialect: "sqlite", ormVersion: "0.45.4", guestFlavor: "slim" },
            { dialect: "sqlite", ormVersion: "1.0.0-rc.5", guestFlavor: "slim" },
          ],
        },
      },
      crossDatabaseShare,
    ];

    for (const card of cards) {
      expect(await renderer.renderSvg(card)).toMatch(/^<svg width="1200" height="630"/);
      // Satori sizes the content box: without border-box the padding pushes the footer below the image.
      expect(layoutOgCard(card).props.style?.boxSizing).toBe("border-box");
    }
  });

  it("should give a card a lime Run button, and a bug repro an amber one with the Bug repro mark and edge", () => {
    const share = layoutOgCard({ kind: "share", topic: "playground", runtime: null });
    const bugRepro = layoutOgCard({ kind: "share", topic: "bug-repros", runtime: null });

    expect(listTextsOn(share, "#c5f74f")).toEqual(["Run"]);
    expect(
      listTextsOn(layoutOgCard({ kind: "page", title: "Community shares", description: "Shared." }), "#c5f74f"),
    ).toEqual(["Run"]);
    expect(listTexts(share)).not.toContain("Bug repro");
    expect(listTextsOn(bugRepro, "#ffb224")).toEqual(["Run"]);
    expect(listTexts(bugRepro)).toContain("Bug repro");
    expect(bugRepro.props.style?.borderLeft).toBe("12px solid #ffb224");
  });

  it("should give an example the Official mark and a Run button, with its database and version", () => {
    const example = layoutOgCard(exampleCard);

    expect(listTextsOn(example, "#c5f74f")).toEqual(["Official", "Run"]);
    expect(listTexts(example)).toEqual(expect.arrayContaining(["PostgreSQL", "1.0.0-rc.5", "RC"]));
  });

  it("should show both versions of a side-by-side share as vs, older first", () => {
    const share = layoutOgCard({
      kind: "share",
      topic: "playground",
      runtime: {
        sides: [
          { dialect: "sqlite", ormVersion: "0.45.4", guestFlavor: "slim" },
          { dialect: "sqlite", ormVersion: "1.0.0-rc.5", guestFlavor: "slim" },
        ],
      },
    });
    const texts = listTexts(share);

    expect(texts.slice(texts.indexOf("SQLite"), texts.indexOf("drizzle.run"))).toEqual([
      "SQLite",
      "0.45.4",
      "Legacy",
      "vs",
      "1.0.0-rc.5",
      "RC",
    ]);
  });

  it("should lead each side with its own database when the sides run on two", () => {
    const texts = listTexts(layoutOgCard(crossDatabaseShare));

    expect(texts.slice(texts.indexOf("PostgreSQL"), texts.indexOf("drizzle.run"))).toEqual(
      expect.arrayContaining(["PostgreSQL", "vs", "SQLite"]),
    );
    expect(texts.indexOf("PostgreSQL")).toBeLessThan(texts.indexOf("vs"));
    expect(texts.indexOf("vs")).toBeLessThan(texts.indexOf("SQLite"));
  });
});
