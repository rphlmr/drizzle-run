const MAX_BYTE_STREAM_CHUNK_BYTES = 64 * 1024;

/** Feeds browser decompression streams bounded input chunks with backpressure. */
export function createChunkedByteStream(bytes: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array<ArrayBuffer>> {
  let offset = 0;

  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }

      const end = Math.min(offset + MAX_BYTE_STREAM_CHUNK_BYTES, bytes.byteLength);
      const chunk = new Uint8Array(end - offset);

      chunk.set(bytes.subarray(offset, end));
      controller.enqueue(chunk);
      offset = end;
    },
    cancel() {
      offset = bytes.byteLength;
    },
  });
}
