import { serializeValue } from "@drizzle-run/core/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { JsonTree } from "./json-tree-view";

const authors = serializeValue([
  { name: "Ada", posts: [{ title: "Hello", comments: [{ body: "Welcome." }, { body: "Nice." }] }] },
  { name: "Grace", posts: [] },
]);

function render(reveal?: readonly string[]) {
  return renderToStaticMarkup(createElement(JsonTree, { value: authors, reveal }));
}

describe("JsonTree", () => {
  it("should open every row and its relations, and fold deeper values to their size", () => {
    const html = render();

    expect(html).toContain('aria-label="Collapse row 1"');
    expect(html).toContain('aria-label="Collapse row 2"');
    expect(html).toContain('aria-label="Collapse posts"');
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(1);
    expect(html).toMatch(/&quot;comments&quot;<\/span>: <span[^>]*>2 items<\/span>/);
  });

  it("should open a revealed value and mark its line", () => {
    const html = render(["0", "posts", "0", "comments"]);

    expect(html).toContain('aria-label="Collapse comments"');
    expect(html).toMatch(/<div class="[^"]*bg-mark[^"]*"[^>]*><button[^>]*aria-label="Collapse comments"/);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
  });

  it("should open the fields of an object and fold their items", () => {
    const html = renderToStaticMarkup(
      createElement(JsonTree, { value: serializeValue({ name: "Ada", posts: [{ title: "Hello" }] }) }),
    );

    expect(html).toContain('aria-label="Collapse posts"');
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(1);
  });
});
