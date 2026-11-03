import type { Fetch } from "../lib/api";
import type { FetchText } from "./guide-tools";

/** What the docs reader needs: the network. */
export interface DocsServiceDependencies {
  /** Sends every request; the browser's `fetch` in the app, a fake in tests. */
  fetch: Fetch;
}

/**
 * Create the reader `read_docs` fetches pages with
 *
 * Reads public pages: no cookies, no referrer. orm.drizzle.team allows any origin.
 */
export function createDocsService({ fetch }: DocsServiceDependencies): FetchText {
  return async (url, signal) => {
    const response = await fetch(url, {
      signal,
      mode: "cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "follow",
    });

    return {
      ok: response.ok,
      status: response.status,
      type: response.headers.get("content-type") ?? "",
      text: response.ok ? await response.text() : "",
      url: response.url,
    };
  };
}
