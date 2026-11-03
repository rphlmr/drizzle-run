import { describe, expect, it } from "vitest";

import { createChunkedByteStream } from "./byte-stream.ts";

describe("createChunkedByteStream", () => {
  it("should feed long input in bounded chunks without changing its bytes", async () => {
    const bytes = Uint8Array.from({ length: 180_321 }, (_, index) => index % 251);
    const reader = createChunkedByteStream(bytes).getReader();
    const chunks: Uint8Array[] = [];
    const chunkSizes: number[] = [];

    for (;;) {
      const next = await reader.read();

      if (next.done) {
        break;
      }

      chunks.push(next.value);
      chunkSizes.push(next.value.byteLength);
    }

    const actual = new Uint8Array(bytes.byteLength);
    let offset = 0;

    for (const chunk of chunks) {
      actual.set(chunk, offset);
      offset += chunk.byteLength;
    }

    expect(chunkSizes).toEqual([65_536, 65_536, 49_249]);
    expect(actual).toEqual(bytes);
  });

  it("should stop producing input after downstream cancellation", async () => {
    const reader = createChunkedByteStream(new Uint8Array(200_000)).getReader();
    const first = await reader.read();

    expect(first.value?.byteLength).toBe(65_536);

    await reader.cancel();

    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });
});
