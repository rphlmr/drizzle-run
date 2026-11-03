import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import { SqliteD1 } from "../test/worker/sqlite-d1";
import { fetchWorker } from "../test/worker/worker-app";
import type { WorkerEnvironment } from "../worker/platform";
import { seedPlaygrounds } from "./seed-d1.ts";

function makeEnvironment(database: SqliteD1): WorkerEnvironment {
  return {
    PLAYGROUNDS: database,
    RUNTIME_ASSETS: {
      async get() {
        return null;
      },
    },
    ASSETS: {
      async fetch() {
        return new Response(null, { status: 404 });
      },
    },
  };
}

describe("seedPlaygrounds", () => {
  it("should seed shares whose latest version the Worker reads", async () => {
    const database = new SqliteD1();
    const environment = makeEnvironment(database);

    const shares = await seedPlaygrounds(drizzle(database), { now: "2026-10-25T10:00:00.000Z" });

    expect(shares.length).toBeGreaterThan(0);

    for (const share of shares) {
      const response = await fetchWorker(new Request(`https://run.test/api/playgrounds/${share.linkId}`), environment);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ digest: share.contentDigest });
    }
  });
});
