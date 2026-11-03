import { describe, expect, it } from "vitest";

import { cn } from "./utils";

describe("cn", () => {
  it("should resolve conflicts on the theme's own keys", () => {
    expect(cn("h-header px-4", "h-12 px-2.5")).toBe("h-12 px-2.5");
    expect(cn("size-7.5", "size-touch")).toBe("size-touch");
    expect(cn("rounded-md", "rounded-pill")).toBe("rounded-pill");
    expect(cn("shadow-sticker", "shadow-none")).toBe("shadow-none");
  });
});
