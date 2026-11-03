import { sha256Bytes } from "@drizzle-run/core/hash";

// Keep the module URL descriptive of content hashing to avoid tracking-filter false positives.
function toCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toCanonicalValue);
  }

  if (value !== null && typeof value === "object") {
    const entries: [string, unknown][] = Object.entries(value);

    return Object.fromEntries(
      entries
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, toCanonicalValue(child)]),
    );
  }

  return value;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Create a type environment fingerprint
 *
 * Hashes the key-sorted JSON of `input` with SHA-256 and keeps the first 24 hex characters. Falls back to the
 * pure SHA-256 implementation when SubtleCrypto is missing (LAN HTTP), so both paths return the same value.
 */
export async function createTypeEnvironmentFingerprint(input: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(toCanonicalValue(input)));
  const subtle = globalThis.crypto?.subtle;
  const digest = subtle === undefined ? sha256Bytes(encoded) : new Uint8Array(await subtle.digest("SHA-256", encoded));

  return toHex(digest).slice(0, 24);
}
