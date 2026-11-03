import { serializeValue, type DisplayResult, type SqlEvent } from "@drizzle-run/core/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResultCard, ResultsEmpty } from "./results";

function render(displays: readonly DisplayResult[]) {
  return displays
    .map((display) => renderToStaticMarkup(createElement(ResultCard, { ...display, statements: [] })))
    .join("");
}

describe("displayed results", () => {
  it("should render labeled tables and multiple values without a default export", () => {
    const html = render([
      { label: "Users", values: [serializeValue([{ name: "Ada" }]), serializeValue([{ total: 1 }])] },
      { label: "Summary", values: [serializeValue({ count: 1 })] },
    ]);
    expect(html.match(/<table\b/g)).toHaveLength(3);
    expect(html).toMatch(/<h3[^>]*>Users<\/h3>/);
    expect(html).toMatch(/<h3[^>]*>Summary<\/h3>/);
    expect(html).toContain("Ada");
    expect(html).not.toContain("undefined");
  });

  it("should offer Table and JSON only for rows a table can show, starting on Table", () => {
    const rows = render([{ label: "Users", values: [serializeValue([{ name: "Ada" }])] }]);

    expect(rows).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Table<\/button>/);
    expect(rows).toMatch(/<button[^>]*aria-pressed="false"[^>]*>JSON<\/button>/);
    expect(render([{ label: "Total", values: [serializeValue(42)] }])).not.toContain("Result view");
  });

  it("should append duplicate labels, escape content, and represent empty arrays", () => {
    const html = render([
      { label: "<script>same</script>", values: [serializeValue([])] },
      { label: "<script>same</script>", values: [serializeValue("<img>")] },
    ]);
    expect(html.match(/<section\b/g)).toHaveLength(2);
    expect(html).toContain("<span>0 rows</span>");
    expect(html).toContain("&lt;img&gt;");
    expect(html).not.toContain("<script>");
  });

  it("should label each display with its row and column counts", () => {
    const html = render([
      { label: "Users", values: [serializeValue([{ name: "Ada" }, { name: "Grace" }])] },
      { label: "One", values: [serializeValue([{ id: 1, name: "Ada" }])] },
    ]);
    expect(html).toContain("2 rows · 1 column<");
    expect(html).toContain("1 row · 2 columns<");
  });

  it("should explain how to display output when nothing was captured", () => {
    expect(renderToStaticMarkup(createElement(ResultsEmpty))).toContain("$.display");
  });
});

describe("result cards", () => {
  const statement: SqlEvent = {
    sequence: 1,
    phase: "run",
    origin: "drizzle",
    kind: "executed",
    sql: 'select "id", "owner" from "accounts"',
    parameters: [],
    outcome: "succeeded",
    durationMs: 0.4,
  };
  const card = (props: Partial<Parameters<typeof ResultCard>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(ResultCard, {
        label: "Balances",
        values: [
          serializeValue([
            { id: 1, owner: "Ada" },
            { id: 2, owner: "Grace" },
          ]),
        ],
        statements: [statement],
        ...props,
      }),
    );

  it("should title the card and count rows and columns", () => {
    const html = card();

    expect(html).toMatch(/<section[^>]*aria-label="Balances"/);
    expect(html).toContain("2 rows · 2 columns");
    expect(html.match(/<table\b/g)).toHaveLength(1);
  });

  it("should fold the SQL footer with the chevron left of Copy", () => {
    const html = card();
    const footer = html.slice(html.indexOf('data-slot="result-sql"'));

    expect(footer).toContain('aria-expanded="false"');
    expect(footer.indexOf("Expand SQL")).toBeLessThan(footer.indexOf(">Copy<"));
    expect(footer).toContain("accounts");
  });

  const authors = [
    {
      name: "Ada",
      posts: [
        { title: "Hello, Drizzle", comments: [{ body: "Welcome aboard.", author: { name: "Grace" } }] },
        { title: "Relations in one query", comments: [] },
      ],
    },
    {
      name: "Grace",
      posts: [
        {
          title: "Types all the way down",
          comments: [
            { body: "Inferred.", author: { name: "Ada" } },
            { body: "No codegen.", author: { name: "Grace" } },
          ],
        },
      ],
    },
  ];

  it("should render relations as tables inside their cells, two levels deep, with many and one hints", () => {
    const html = card({ label: "Authors", values: [serializeValue(authors)] });

    expect(html.match(/<table\b/g)).toHaveLength(1 + 2 + 2);
    expect(html).not.toContain("<dl");
    expect(html.match(/>posts <span[^>]*>many<\/span>/g)).toHaveLength(1);
    expect(html.match(/>comments <span[^>]*>many<\/span>/g)).toHaveLength(2);
    expect(html.match(/>author <span[^>]*>one<\/span>/g)).toHaveLength(2);
    expect(html).toContain("2 rows · 2 columns");
  });

  it("should show a third level as a chip with its size, and an empty relation as []", () => {
    const html = card({ label: "Authors", values: [serializeValue(authors)] });

    expect(html.match(/aria-label="Open author in JSON, 1 field"/g)).toHaveLength(3);
    expect(html).not.toContain("Grace</td></tr></tbody></table></td>");
    expect(html).toMatch(/<span class="[^"]*font-mono[^"]*">\[\]<\/span>/);
  });

  it("should count a third-level array in items", () => {
    const html = card({
      label: "Deep",
      values: [serializeValue([{ a: [{ b: [{ c: [{ d: 1 }, { d: 2 }, { d: 3 }] }] }] }])],
    });

    expect(html).toContain('aria-label="Open c in JSON, 3 items"');
  });

  it("should show a related object as a one-row table, and a displayed object as one row", () => {
    const posts = card({ label: "Posts", values: [serializeValue([{ title: "Hello", author: { name: "Ada" } }])] });
    const user = card({ label: "User", values: [serializeValue({ name: "Ada", posts: [] })] });

    expect(posts.match(/<table\b/g)).toHaveLength(2);
    expect(posts).toMatch(/>author <span[^>]*>one<\/span>/);
    expect(user).toContain("1 row · 2 columns");
    expect(user).toMatch(/>posts <span[^>]*>many<\/span>/);
    expect(user).toMatch(/<button[^>]*aria-pressed="false"[^>]*>JSON<\/button>/);
  });

  it("should name the default export and leave the footer out without SQL", () => {
    const html = card({ label: undefined, values: [serializeValue(42)], statements: [] });

    expect(html).toContain("Default export");
    expect(html).not.toContain("result-sql");
  });
});
