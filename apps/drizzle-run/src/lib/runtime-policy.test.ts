import { describe, expect, it } from "vitest";

import { getRuntimePolicy } from "./runtime-policy";

describe("getRuntimePolicy", () => {
  it.each([
    ["iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", 5],
    ["iPad", "Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", 5],
    ["iPad in desktop mode", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", 5],
    [
      "Android phone",
      "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36",
      5,
    ],
    [
      "Android tablet",
      "Mozilla/5.0 (Linux; Android 16; Pixel Tablet) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
      10,
    ],
  ])("should run sequentially on %s", (_device, userAgent, maxTouchPoints) => {
    expect(getRuntimePolicy({ userAgent, maxTouchPoints })).toEqual({
      preparation: "on_demand",
      execution: "sequential",
    });
  });

  it.each([
    ["Mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", 0],
    ["Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", 0],
    ["Windows with a touchscreen", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", 10],
    ["Linux", "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/144.0", 0],
  ])("should run in parallel on %s", (_device, userAgent, maxTouchPoints) => {
    expect(getRuntimePolicy({ userAgent, maxTouchPoints })).toEqual({ preparation: "eager", execution: "parallel" });
  });

  it("should use sequential execution without a browser", () => {
    expect(getRuntimePolicy(undefined)).toEqual({ preparation: "on_demand", execution: "sequential" });
  });
});
