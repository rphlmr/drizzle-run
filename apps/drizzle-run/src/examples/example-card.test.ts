import type { GuideProgress } from "@drizzle-run/runtime/machines";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { findExample } from "./catalog";
import { ExampleCard, type ExampleCardProps } from "./example-card";

const example = findExample("drizzle-in-five-minutes")!;
const guide = example.guide!;

function renderCard(props: Partial<ExampleCardProps> = {}) {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(ExampleCard, {
        version: example,
        title: example.title,
        status: "not_viewed",
        onQuickLook: () => undefined,
        ...props,
      }),
    ),
  );
}

describe("example card", () => {
  it("should open the example and leave an unread guide unmarked", () => {
    const html = renderCard();

    expect(html).toContain('href="/examples/drizzle-in-five-minutes"');
    expect(html).toContain("Guide · 7 steps");
    expect(html).toContain("Quick look: Drizzle in five minutes");
    expect(html).not.toContain('data-slot="example-status"');
  });

  it("should count the steps done of a guide in progress", () => {
    const progress: GuideProgress = {
      guideId: guide.id,
      stepId: guide.steps[2].id,
      completed: [guide.steps[0].id, guide.steps[1].id],
      finished: false,
    };
    const html = renderCard({ status: "in_progress", progress });

    expect(html).toContain("2/7 steps");
  });

  it("should mark a finished guide done and a visited example viewed", () => {
    expect(renderCard({ status: "completed" })).toContain("Done");
    expect(renderCard({ version: findExample("insert-validators")!, status: "viewed" })).toContain("Viewed");
  });

  it("should open a guide step and show the match in place of the description", () => {
    const html = renderCard({ href: "/examples/drizzle-in-five-minutes?step=3", detail: "Step 3 · Joins" });

    expect(html).toContain('href="/examples/drizzle-in-five-minutes?step=3"');
    expect(html).toContain("Step 3 · Joins");
    expect(html).not.toContain(example.description);
  });

  it("should name the database an example is limited to", () => {
    expect(renderCard({ onlyOn: "PostgreSQL" })).toContain("PostgreSQL only");
  });

  it.each([
    ["relational-queries", "Drizzle 0.45.4 vs Drizzle 1.0.0-rc.5"],
    ["select-vs-relational-queries", "SQL-like vs RQB"],
    ["postgresql-vs-sqlite", "PostgreSQL vs SQLite"],
  ])("should say what %s compares", (slug, comparison) => {
    const html = renderCard({ version: findExample(slug)!, title: slug });

    expect(html).toContain(comparison);
    expect(html).toContain("Side by side");
  });
});
