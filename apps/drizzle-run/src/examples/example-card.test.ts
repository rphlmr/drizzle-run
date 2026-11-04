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
  viewedAt,
}: {
  progress?: GuideProgress;
  featured: boolean;
  example?: OfficialExample;
  viewedAt?: string;
}) {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(ExampleCard, { example: cardExample, progress, featured, viewedAt }),
    ),
  );
}

describe.each([false, true])("guide card (featured: %s)", (featured) => {
  it("should leave unread guides unmarked", () => {
    const html = renderCard({ featured });

    expect(html).toContain("Start guide");
    expect(html).not.toContain('data-slot="guide-status"');
  });

  it("should show opened guides as viewed before the first step is completed", () => {
    const html = renderCard({
      featured,
      progress: { guideId: guide.id, stepId: guide.steps[0].id, completed: [], finished: false },
    });

    expect(html).toContain("Viewed");
    expect(html).toContain("Continue guide");
    expect(html).not.toContain('data-slot="guide-progress"');
  });

  it("should show progress after a step has been completed", () => {
    const html = renderCard({
      featured,
      progress: { guideId: guide.id, stepId: guide.steps[1].id, completed: [guide.steps[0].id], finished: false },
    });

    expect(html).toContain("In progress");
    expect(html).toContain("1 of 7 steps completed");
  });

  it("should mark a visited plain example without inventing guide progress", () => {
    const html = renderCard({ featured, example: findExample("insert-validators")!, viewedAt: "2026-11-04T10:00:00Z" });

    expect(html).toContain("Viewed");
    expect(html).not.toContain("In progress");
    expect(html).not.toContain("Completed");
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
      viewedAt: "2026-11-04T10:00:00Z",
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
