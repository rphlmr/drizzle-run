import type { APIRequestContext, APIResponse } from "@playwright/test";
import { delay } from "es-toolkit";

import { appOrigin } from "./fixtures";
import { ensureSignedInWithGitHub } from "./github";

const RETRY_WINDOW_MS = 90_000;
const RETRY_DELAY_MS = 5_000;

/**
 * Publishes a snapshot (`data`) through the app API, as the account `request` is signed in with, or as the mock's
 * default account when it has no session. The e2e server raises the publish limit (wrangler.jsonc env.e2e), so a 429
 * should not happen; if one does, it waits for the window to reopen instead of failing the test.
 */
export async function postSnapshot(
  request: APIRequestContext,
  {
    data,
    description = null,
    baseUrl = appOrigin,
  }: {
    data: unknown;
    /** The share's one-line description, as the Share dialog sends it. */
    description?: string | null;
    baseUrl?: string;
  },
): Promise<APIResponse> {
  const origin = new URL(baseUrl).origin;
  const idempotencyKey = crypto.randomUUID();
  const deadline = Date.now() + RETRY_WINDOW_MS;
  await ensureSignedInWithGitHub(request);

  for (;;) {
    const response = await request.post(new URL("/api/playgrounds", baseUrl).href, {
      headers: { Origin: origin, "Idempotency-Key": idempotencyKey },
      data: { snapshot: data, description },
    });

    if (response.status() !== 429 || Date.now() > deadline) {
      return response;
    }

    await delay(RETRY_DELAY_MS);
  }
}
