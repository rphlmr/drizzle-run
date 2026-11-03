import { toHex } from "../lib/hex";

/** Creates a UUID v4, also where `crypto.randomUUID` is missing, such as on LAN HTTP. */
export function createLocalId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  // LAN HTTP has getRandomValues even when randomUUID is unavailable.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = toHex(bytes);

  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}
