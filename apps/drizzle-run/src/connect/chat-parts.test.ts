import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SetupBody, ToolRow } from "./chat-parts";

describe("tool rows", () => {
  it("should open a docs call to its link even when it fits", () => {
    const docs = renderToStaticMarkup(
      createElement(ToolRow, {
        item: {
          kind: "tool",
          key: "x:3",
          label: "Read docs",
          target: "orm.drizzle.team/docs/transactions",
          link: "https://orm.drizzle.team/docs/transactions",
          tone: "ok",
          spinning: false,
        },
      }),
    );

    expect(docs).toMatch(/<button type="button" aria-expanded="false"/);
  });

  it("should open a failed call to its error, and keep a call that fits plain", () => {
    const failed = renderToStaticMarkup(
      createElement(ToolRow, {
        item: {
          kind: "tool",
          key: "x:1",
          label: "Read",
          target: "missing.ts",
          tone: "err",
          spinning: false,
          error: "No file",
        },
      }),
    );
    const done = renderToStaticMarkup(
      createElement(ToolRow, {
        item: { kind: "tool", key: "x:2", label: "Read", target: "schema.ts", tone: "ok", spinning: false },
      }),
    );

    expect(failed).toMatch(/<button type="button" aria-expanded="false"/);
    expect(failed).not.toContain('data-slot="tool-details"');
    expect(done).not.toContain("<button");
  });
});

describe("setup body", () => {
  it("should wait for the link code, offer a new one after a Forget, and say why one failed with Try again", () => {
    const waiting = renderToStaticMarkup(createElement(SetupBody, { command: undefined, secret: undefined }));
    const forgotten = renderToStaticMarkup(
      createElement(SetupBody, { command: undefined, secret: undefined, onNewCode: () => undefined }),
    );
    const failed = renderToStaticMarkup(
      createElement(SetupBody, {
        command: undefined,
        secret: undefined,
        error: "The disk is full.",
        onNewCode: () => undefined,
      }),
    );

    expect(waiting).toContain("Making a link code");
    expect(forgotten).toContain("New link code");
    expect(forgotten).not.toContain('role="alert"');
    expect(failed).toContain("Could not make a link code. The disk is full.");
    expect(failed).toContain("Try again");
  });
});
