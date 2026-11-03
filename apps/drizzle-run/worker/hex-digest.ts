const textEncoder = new TextEncoder();

/** Bytes as lowercase hex, two digits per byte. */
export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The SHA-256 of text's UTF-8 bytes, as hex. */
export async function digestTextHex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", textEncoder.encode(text)));
}
