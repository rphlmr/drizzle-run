import { createHash, webcrypto } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTypeEnvironmentFingerprint } from "./content-hash.ts";

afterEach(() => vi.unstubAllGlobals());

describe("createTypeEnvironmentFingerprint", () => {
  it("should preserve SHA-256 fingerprints without SubtleCrypto on LAN HTTP", async () => {
    const input = { z: ["é", { b: 2, a: 1 }], a: "schema" };
    const canonical = { a: "schema", z: ["é", { a: 1, b: 2 }] };
    const expected = createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 24);

    vi.stubGlobal("crypto", webcrypto);
    expect(await createTypeEnvironmentFingerprint(input)).toBe(expected);

    vi.stubGlobal("crypto", {});
    expect(await createTypeEnvironmentFingerprint(input)).toBe(expected);
  });
});
