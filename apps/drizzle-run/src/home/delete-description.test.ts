import { describe, expect, it } from "vitest";

import { describeProjectDeletion } from "./delete-description";

describe("describeProjectDeletion", () => {
  it("should say a Local project leaves only this browser", () => {
    expect(describeProjectDeletion({ names: ["Users"], cloudCount: 0, sharedCount: 0 })).toBe(
      "This removes Users from this browser. Export a JSON backup first if you need it.",
    );
  });

  it("should say a Cloud project leaves the account and the other browsers too", () => {
    expect(describeProjectDeletion({ names: ["Users"], cloudCount: 1, sharedCount: 0 })).toBe(
      "This removes Users from this browser, your account and your other browsers. Export a JSON backup first if you need it.",
    );
  });

  it("should name the Cloud ones when only some of several projects are Cloud", () => {
    expect(describeProjectDeletion({ names: ["Users", "Posts"], cloudCount: 1, sharedCount: 0 })).toBe(
      "This removes them from this browser, and the Cloud ones from your account and your other browsers. Export a JSON backup first if you need them.",
    );
  });
});

describe("describeProjectDeletion with share links", () => {
  it("should say one project's share link stays public and where to delete it", () => {
    expect(describeProjectDeletion({ names: ["Users"], cloudCount: 0, sharedCount: 1 })).toBe(
      "This removes Users from this browser. Its share link stays public. To take it down, stop sharing it from Share first. Shares made while signed in can also be stopped later from My shares. Export a JSON backup first if you need it.",
    );
  });

  it("should name the shared ones when only some of several projects have a link", () => {
    expect(describeProjectDeletion({ names: ["Users", "Posts"], cloudCount: 0, sharedCount: 1 })).toContain(
      "The share links of the shared ones stay public.",
    );
  });
});
