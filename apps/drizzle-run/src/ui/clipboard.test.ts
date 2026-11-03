import { describe, expect, it } from "vitest";

import { copyText } from "./clipboard";

describe("copyText", () => {
  it("should report a successful copy", async () => {
    const written: string[] = [];

    await expect(
      copyText("select 1", {
        writeText: async (text) => {
          written.push(text);
        },
      }),
    ).resolves.toBe("copied");
    expect(written).toEqual(["select 1"]);
  });

  it("should report a refused copy instead of rejecting", async () => {
    await expect(
      copyText("select 1", { writeText: () => Promise.reject(new DOMException("Denied", "NotAllowedError")) }),
    ).resolves.toBe("failed");
  });

  it("should report a missing clipboard (insecure context) as failed", async () => {
    await expect(copyText("select 1", undefined)).resolves.toBe("failed");
  });
});
