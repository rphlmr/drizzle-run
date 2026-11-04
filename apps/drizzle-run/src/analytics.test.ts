import { configure } from "onedollarstats";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeAnalytics } from "./analytics";

vi.mock("onedollarstats", () => ({ configure: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("initializeAnalytics", () => {
  it("should enable tracking on the production origin in a production build", () => {
    initializeAnalytics({ production: true, origin: "https://drizzle.run" });

    expect(configure).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([
    { production: false, origin: "https://drizzle.run" },
    { production: true, origin: "http://localhost:5173" },
    { production: true, origin: "https://next.drizzle.run" },
    { production: true, origin: "https://pr-5.example.workers.dev" },
    { production: true, origin: "https://drizzle-run.example.workers.dev" },
    { production: true, origin: "http://drizzle.run" },
  ])("should leave analytics off for $origin with production=$production", (options) => {
    initializeAnalytics(options);

    expect(configure).not.toHaveBeenCalled();
  });
});
