const maxProtocolBytes = 2 * 1024 * 1024;

export function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

/** Keep partial frames until the next socket write. Startup and encryption packets have no type byte. */
export function createFrameReader(startsWithStartup: boolean) {
  let buffered = new Uint8Array();
  let typed = !startsWithStartup;

  return function read(bytes: Uint8Array) {
    const joined = new Uint8Array(buffered.length + bytes.length);
    joined.set(buffered);
    joined.set(bytes, buffered.length);
    const frames: { type: number | undefined; body: Uint8Array; bytes: Uint8Array }[] = [];
    let offset = 0;

    if (joined.length > maxProtocolBytes) {
      throw new RangeError("PostgreSQL exchange exceeds 2 MiB");
    }

    while (joined.length - offset >= (typed ? 5 : 4)) {
      const length = typed ? readUint32(joined, offset + 1) + 1 : readUint32(joined, offset);

      if (length < (typed ? 5 : 8) || length > maxProtocolBytes) {
        throw new RangeError("Invalid PostgreSQL frame length");
      }

      if (joined.length - offset < length) {
        break;
      }

      frames.push({
        type: typed ? joined[offset] : undefined,
        body: joined.subarray(offset + (typed ? 5 : 4), offset + length),
        bytes: joined.subarray(offset, offset + length),
      });
      typed ||= !(length === 8 && [80_877_103, 80_877_104].includes(readUint32(joined, offset + 4)));
      offset += length;
    }

    buffered = joined.slice(offset);

    return frames;
  };
}
