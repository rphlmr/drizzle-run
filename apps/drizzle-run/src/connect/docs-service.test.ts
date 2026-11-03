import { describe, expect, it, vi } from "vitest";

import type { Fetch } from "../lib/api";
import { createDocsService } from "./docs-service";

const docsUrl = "https://orm.drizzle.team/docs/select";

describe("docs service", () => {
  it("should read a public page without cookies or a referrer, and stop when the tool call stops", async () => {
    const { signal } = new AbortController();
    const fetchMock = vi.fn<Fetch>(
      async () => new Response("# Select", { status: 200, headers: { "content-type": "text/markdown" } }),
    );

    await expect(createDocsService({ fetch: fetchMock })(docsUrl, signal)).resolves.toEqual({
      ok: true,
      status: 200,
      type: "text/markdown",
      text: "# Select",
      url: "",
    });
    expect(fetchMock).toHaveBeenCalledWith(docsUrl, {
      signal,
      mode: "cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "follow",
    });
  });

  it("should keep the status of a failed page and skip its body", async () => {
    const fetchMock = vi.fn<Fetch>(async () => new Response("Not found", { status: 404 }));

    await expect(createDocsService({ fetch: fetchMock })(docsUrl, new AbortController().signal)).resolves.toMatchObject(
      {
        ok: false,
        status: 404,
        text: "",
      },
    );
  });
});
