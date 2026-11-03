import type { GuideProgress } from "@drizzle-run/runtime/machines";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { findExample, type OfficialExample } from "./catalog";
import { ExampleCard } from "./example-card";

const example = findExample("drizzle-in-five-minutes")!;
const guide = example.guide!;

function renderCard({
  progress,
  featured,
  example: cardExample = example,
}: {
  progress?: GuideProgress;
  featured: boolean;
  example?: OfficialExample;
}) {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(ExampleCard, { example: cardExample, progress, featured })),
  );
}

describe.each([false, true])("guide card (featured: %s)", (featured) => {
  it("should leave unread guides unmarked", () => {
    const html = renderCard({ featured });

    expect(html).toContain("Start guide");
    expect(html).not.toContain('data-slot="guide-status"');
  });

  it("should show opened guides as in progress before the first step is completed", () => {
    const html = renderCard({
      featured,
      progress: { guideId: guide.id, stepId: guide.steps[0].id, completed: [], finished: false },
    });

    expect(html).toContain("In progress");
    expect(html).toContain("Continue guide");
    expect(html).toContain("0 of 7 steps completed");
  });

  it("should distinguish finished guides from ones still in progress", () => {
    const html = renderCard({
      featured,
      progress: {
        guideId: guide.id,
        stepId: guide.steps[guide.steps.length - 1].id,
        completed: guide.steps.map((step) => step.id),
        finished: true,
      },
    });

    expect(html).toContain("Completed");
    expect(html).toContain("Revisit guide");
    expect(html).not.toContain("In progress");
    expect(html).not.toContain('data-slot="guide-progress"');
    expect(html).not.toContain("Start here");
  });
});

describe("card comparison context", () => {
  it("should retain exact releases when a guide compares ORM versions", () => {
    const html = renderCard({ featured: false, example: findExample("relational-queries")! });

    expect(html).toContain("Drizzle 0.45.4 vs Drizzle 1.0.0-rc.5");
  });

  it.each([
    ["select-vs-relational-queries", "SQL-like vs RQB"],
    ["postgresql-vs-sqlite", "PostgreSQL vs SQLite"],
  ])("should identify what %s compares without repeating a shared release", (slug, comparison) => {
    const html = renderCard({ featured: false, example: findExample(slug)! });

    expect(html).toContain(comparison);
    expect(html).not.toContain("1.0.0-rc.5");
  });
});
