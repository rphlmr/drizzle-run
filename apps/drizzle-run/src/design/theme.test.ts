import { describe, expect, it } from "vitest";

import { readEmbedTheme, readPreference, resolveTheme } from "./theme";

describe("theme preference", () => {
  it("should fall back to system for a missing or unknown value", () => {
    expect(readPreference({ getItem: () => null })).toBe("system");
    expect(readPreference({ getItem: () => "sepia" })).toBe("system");
    expect(readPreference(null)).toBe("system");
  });

  it("should fall back to system when storage throws", () => {
    expect(
      readPreference({
        getItem: () => {
          throw new DOMException("blocked", "SecurityError");
        },
      }),
    ).toBe("system");
  });

  it("should keep a stored light or dark preference", () => {
    expect(readPreference({ getItem: () => "dark" })).toBe("dark");
    expect(readPreference({ getItem: () => "light" })).toBe("light");
  });

  it("should resolve system from the media query", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
  });
});

describe("readEmbedTheme", () => {
  it("should read the host's theme on an embed page", () => {
    expect(readEmbedTheme({ pathname: "/embed/abc123", search: "?theme=light" })).toBe("light");
    expect(readEmbedTheme({ pathname: "/embed/examples/transactions", search: "?theme=dark" })).toBe("dark");
  });

  it("should ignore an unknown theme, a missing one, and any page outside the embed", () => {
    expect(readEmbedTheme({ pathname: "/embed/abc123", search: "?theme=sepia" })).toBeNull();
    expect(readEmbedTheme({ pathname: "/embed/abc123", search: "" })).toBeNull();
    expect(readEmbedTheme({ pathname: "/s/abc123", search: "?theme=dark" })).toBeNull();
  });
});
