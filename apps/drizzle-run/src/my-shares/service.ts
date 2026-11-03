import { readApiErrorCode, readJsonBody, sendApiRequest, type Fetch } from "../lib/api";
import { MySharesError, MySharesPageResponseSchema, type MySharesService } from "./contract";

/** What the My shares API needs: the network and the origin it runs on. */
export interface MySharesServiceDependencies {
  /** Sends every request; the browser's `fetch` in the app, a fake in tests. */
  fetch: Fetch;
  /** The Drizzle Run origin requests go to, such as `https://drizzle.run`. */
  origin: string;
}

/** Create the My shares API, sending every request to `origin`. */
export function createMySharesService({ fetch, origin }: MySharesServiceDependencies): MySharesService {
  return {
    async fetchMySharesPage({ cursor, search, signal }) {
      const params = new URLSearchParams();

      if (cursor !== undefined) {
        params.set("cursor", cursor);
      }

      if (search !== "") {
        params.set("q", search);
      }

      const query = params.size === 0 ? "" : `?${params}`;
      const response = await sendApiRequest(fetch, new URL(`/api/me/shares${query}`, origin).href, {
        headers: { accept: "application/json" },
        signal,
      });

      if (!response.ok) {
        const code = await readApiErrorCode(response, signal);

        throw code === "sign_in_required"
          ? new MySharesError("sign_in_required", "Sign in with GitHub to see your shares.")
          : new MySharesError("shares_unavailable", "Your shares could not be loaded. Try again in a moment.");
      }

      const parsed = MySharesPageResponseSchema.safeParse(await readJsonBody(response, signal));

      if (!parsed.success) {
        throw new MySharesError("shares_unavailable", "Drizzle Run returned an invalid list of shares.", {
          cause: parsed.error,
        });
      }

      return { shares: parsed.data.shares, nextCursor: parsed.data.nextCursor ?? undefined };
    },
  };
}
